/**
 * Read-only git access for the commit-diff panel.
 *
 * Every call runs `git` directly (argv, no shell) in the requested repository.
 * Only reads are used (rev-parse, symbolic-ref, for-each-ref, log, rev-list,
 * show, diff, merge-base, format-patch --stdout, cat-file, config/remote reads):
 * nothing writes refs, the index, the worktree or talks to a remote. Hardening:
 *  - `--no-ext-diff --no-textconv`: repo/user config cannot run a diff driver.
 *  - `-c core.fsmonitor=false`: a repo's config cannot start an fsmonitor hook.
 *  - `--src-prefix/--dst-prefix` + `color.ui=false`: config cannot change the
 *    text the parser reads.
 *  - Client revisions go after `--end-of-options` and paths after `--`, so a
 *    value can never be read as an option or as the other kind of argument.
 *    (The schema already refuses a leading "-"; this is the second lock.)
 *  - Search text uses `-i -F`: what the user typed is a literal, not a regex.
 *  - `GIT_OPTIONAL_LOCKS=0`: reading never contends with the user's own git.
 *  - Timeout and output cap so a huge or wedged repo cannot hang the daemon.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { highlightCodeWithBudget, isLanguageSupported } from "@getpaseo/highlight";
import { execCommand } from "@getpaseo/plugin/server";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import type { RpcInput } from "@getpaseo/plugin";
import type {
  Commit, DiffTarget, GitRef, fileDiffRpc, fileLinesRpc, listCommitsRpc, listRefsRpc, patchRpc,
  resolveRepoRpc, showCommitRpc, showRangeRpc,
} from "../shared/git";
import { addSyntaxTokens, toRuns, yieldToEventLoop } from "./highlight";
import { parsePatch } from "./patch";

const TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_PATCH_TEXT = 20 * 1024 * 1024;
const MAX_RANGE_COMMITS = 500;
const MAX_REFS = 2000;
/** "Load full diff": one file, far past the per-commit cut, still bounded. */
const FILE_DIFF_LIMITS = { maxPerFile: 50_000, maxTotal: 50_000 };
const CONFIG = ["-c", "core.fsmonitor=false", "-c", "color.ui=false", "-c", "core.quotePath=true"];
/** Exactly what parsePatch expects, whatever the user's diff config says. */
const DIFF_FLAGS = [
  "--find-renames", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/",
];
/** Unit/record separators: cannot appear in names or subjects git prints. */
const FIELD = "\x1f";
const RECORD = "\x1e";
const COMMIT_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%s"].join("%x1f");
/**
 * The record separator goes FIRST: `--shortstat` prints its line after each
 * formatted record, so each chunk is "fields\n\n N files changed, ...".
 */
const LOG_FORMAT = `--format=%x1e${COMMIT_FORMAT}`;

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execCommand("git", [...CONFIG, ...args], {
      cwd,
      // Literal pathspecs: a client path like ":(exclude)x" or ":/" is a file name, not magic.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
    });
    return stdout;
  } catch (error) {
    // Surface git's own one-line reason ("unknown revision", "not a git repository").
    const stderr = (error as { stderr?: string }).stderr?.trim();
    const reason = stderr?.split("\n").find((line) => line.startsWith("fatal:")) ?? stderr;
    throw new Error(reason || (error as Error).message);
  }
}

/** Resolves to the output, or null when git fails (a probe, not an error). */
const probe = (cwd: string, args: string[]) => git(cwd, args).then((out) => out.trim(), () => null);

/** `~` expansion + normalisation. The schema already required an absolute path. */
function expand(path: string): string {
  return resolve(path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path);
}

export async function resolveRepo({ path }: RpcInput<typeof resolveRepoRpc>) {
  const directory = expand(path);
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`No such directory: ${directory}`);
  const root = (await git(directory, ["rev-parse", "--show-toplevel"])).trim();
  const [branch, defaultBranch, web] = await Promise.all([
    probe(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).then((out) => out || null), // null: detached
    findDefaultBranch(root),
    findWeb(root),
  ]);
  return { root, branch, defaultBranch, web };
}

/** origin/HEAD as git reports it ("origin/main"), else a local main/master. */
async function findDefaultBranch(root: string): Promise<string | null> {
  const originHead = await probe(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead) return originHead;
  for (const name of ["main", "master"]) {
    if (await probe(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])) return name;
  }
  return null;
}

async function findWeb(root: string) {
  const remotes = (await probe(root, ["remote"]))?.split("\n").filter(Boolean) ?? [];
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (!remote) return null;
  // The raw URL may carry a token; it is only ever passed to parseRemoteUrl, never logged.
  const url = await probe(root, ["config", "--get", `remote.${remote}.url`]);
  return url ? parseRemoteUrl(url) : null;
}

/**
 * A remote URL to its web page, with any userinfo (user, password, token)
 * dropped. Accepts `git@host:org/repo(.git)`, `ssh://[user@]host[:port]/org/repo`
 * and `http(s)://[userinfo@]host[:port]/org/repo`; anything else (local paths,
 * file://, unknown schemes) is null. The SSH port is not the web port, so it is
 * dropped; an http(s) port is kept.
 */
export function parseRemoteUrl(raw: string) {
  const text = raw.trim();
  let host: string;
  let path: string;
  let scheme = "https";
  const scp = /^(?:[^@/:\s]+@)?([^@/:\s]+):(?!\/)([^\s]+)$/.exec(text);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try { url = new URL(text); } catch { return null; }
    if (url.protocol === "ssh:" || url.protocol === "git+ssh:") host = url.hostname;
    else if (url.protocol === "https:" || url.protocol === "http:") {
      host = url.host;
      scheme = url.protocol.slice(0, -1);
    } else return null;
    path = url.pathname;
  } else if (scp) {
    [, host = "", path = ""] = scp;
  } else return null;

  path = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (!host || !/^[A-Za-z0-9.-]+(:\d+)?$/.test(host) || !path.includes("/")) return null;
  let web: URL;
  try { web = new URL(`${scheme}://${host}/${path}`); } catch { return null; }
  if (web.username || web.password || web.search || web.hash) return null;
  const hostname = web.hostname.toLowerCase();
  const forge = hostname === "github.com" ? "github" : hostname.includes("gitlab") ? "gitlab" : "other";
  return { url: web.href.replace(/\/$/, ""), forge } as const;
}

export async function listRefs({ repo }: RpcInput<typeof listRefsRpc>) {
  const root = expand(repo);
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname)%1f%(objectname)%1f%(*objectname)%1f%(HEAD)%1f%(symref)",
    "refs/heads", "refs/remotes", "refs/tags",
  ]);
  const order = { branch: 0, remote: 1, tag: 2 } as const;
  const refs: GitRef[] = [];
  for (const line of out.split("\n")) {
    const [refname = "", sha = "", peeled = "", head = "", symref = ""] = line.split(FIELD);
    if (!refname || symref) continue; // origin/HEAD and other symbolic refs
    const kind = refname.startsWith("refs/heads/") ? "branch" : refname.startsWith("refs/remotes/") ? "remote" : "tag";
    const name = refname.replace(/^refs\/(heads|remotes|tags)\//, "");
    // An annotated tag's own object is the tag; the commit is what log wants.
    refs.push({ name, kind, sha: peeled || sha, current: head === "*" });
  }
  refs.sort((a, b) =>
    Number(b.current) - Number(a.current) || order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  return { refs: refs.slice(0, MAX_REFS) };
}

export async function listCommits({ repo, ref = "HEAD", filter, skip, limit }: RpcInput<typeof listCommitsRpc>) {
  const root = expand(repo);
  // An empty repository has no HEAD yet: no commits, not an error.
  if ((await probe(root, ["rev-parse", "--verify", "--quiet", "HEAD"])) === null) {
    return { commits: [], upstream: null, unpushed: [] };
  }
  const limiting: string[] = [];
  if (filter?.grep) limiting.push(`--grep=${filter.grep}`);
  if (filter?.author) limiting.push(`--author=${filter.author}`);
  if (limiting.length) limiting.unshift("-i", "-F");
  const commits = await logCommits(root, [
    `--skip=${skip}`, `--max-count=${limit}`, ...limiting,
    "--end-of-options", ref, "--", ...(filter?.path ? [filter.path] : []),
  ]);
  if (skip > 0) return { commits, upstream: null, unpushed: [] };

  // Full name for the range (unambiguous), short name for display.
  const upstreamRef = await probe(root, ["rev-parse", "--verify", "--quiet", "--symbolic-full-name", "--end-of-options", `${ref}@{upstream}`]);
  if (!upstreamRef) return { commits, upstream: null, unpushed: [] };
  const unpushed = await probe(root, [
    "rev-list", `--max-count=${MAX_RANGE_COMMITS}`, "--end-of-options", `${upstreamRef}..${ref}`, "--",
  ]);
  return {
    commits,
    upstream: upstreamRef.replace(/^refs\/(heads|remotes)\//, ""),
    unpushed: unpushed?.split("\n").filter(Boolean) ?? [],
  };
}

/** `git log` with stats; merges are counted against their first parent, as they are shown. */
async function logCommits(root: string, args: string[]): Promise<Commit[]> {
  const out = await git(root, ["log", LOG_FORMAT, "--shortstat", "--diff-merges=first-parent", ...args]);
  return out.split(RECORD).filter(Boolean).map((chunk) => {
    const newline = chunk.indexOf("\n");
    const fields = newline === -1 ? chunk : chunk.slice(0, newline);
    return { ...toCommit(fields), stats: parseShortstat(newline === -1 ? "" : chunk.slice(newline)) };
  });
}

/** " 3 files changed, 10 insertions(+), 2 deletions(-)"; either count may be missing. */
export function parseShortstat(text: string): Commit["stats"] {
  const files = /(\d+) files? changed/.exec(text);
  if (!files) return null;
  const count = (pattern: RegExp) => Number(pattern.exec(text)?.[1] ?? 0);
  return { files: Number(files[1]), additions: count(/(\d+) insertions?\(\+\)/), deletions: count(/(\d+) deletions?\(-\)/) };
}

export async function showCommit({ repo, sha }: RpcInput<typeof showCommitRpc>) {
  const root = expand(repo);
  const [meta, patch] = await Promise.all([
    git(root, ["show", "--no-patch", `--format=${COMMIT_FORMAT}%x1f%b`, "--end-of-options", sha, "--"]),
    // A merge shows what it brought in relative to its first parent, like GitHub.
    git(root, ["show", "--format=", "--patch", ...DIFF_FLAGS, "--diff-merges=first-parent", "--end-of-options", sha, "--"]),
  ]);
  const fields = meta.replace(/\n+$/, "").split(FIELD);
  const files = parsePatch(patch);
  await addSyntaxTokens(files);
  // parsePatch's counts are exact even when lines are cut, so they are the stats.
  const stats = files.length
    ? {
        files: files.length,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      }
    : null;
  return {
    commit: { ...toCommit(fields.slice(0, 6).join(FIELD)), stats, body: (fields[6] ?? "").trim() },
    files,
  };
}

/** Both ends as commits, and where head branched off base (what a PR compares against). */
async function resolveRange(root: string, base: string, head: string) {
  const commitOf = async (rev: string) =>
    (await git(root, ["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`])).trim();
  const [baseSha, headSha] = await Promise.all([commitOf(base), commitOf(head)]);
  const mergeBase = await probe(root, ["merge-base", baseSha, headSha]);
  if (!mergeBase) throw new Error(`No common history between ${base} and ${head}`);
  return { baseSha, headSha, mergeBase };
}

export async function showRange({ repo, base, head }: RpcInput<typeof showRangeRpc>) {
  const root = expand(repo);
  const range = await resolveRange(root, base, head);
  const [commits, patch] = await Promise.all([
    logCommits(root, [`--max-count=${MAX_RANGE_COMMITS}`, "--end-of-options", `${range.mergeBase}..${range.headSha}`, "--"]),
    git(root, ["diff", ...DIFF_FLAGS, range.mergeBase, range.headSha, "--"]),
  ]);
  const files = parsePatch(patch);
  await addSyntaxTokens(files);
  return { ...range, commits, files };
}

/** The patch text of a target, optionally for one path. */
async function targetPatch(root: string, target: DiffTarget, paths: string[]): Promise<string> {
  if (target.kind === "commit") {
    return git(root, [
      "show", "--format=", "--patch", ...DIFF_FLAGS, "--diff-merges=first-parent", "--end-of-options", target.sha, "--", ...paths,
    ]);
  }
  const { mergeBase, headSha } = await resolveRange(root, target.base, target.head);
  return git(root, ["diff", ...DIFF_FLAGS, mergeBase, headSha, "--", ...paths]);
}

/**
 * One file, uncut. With `-- path`, a rename's old side is not matched, so a
 * renamed file shows as added; that is accepted for "Load full diff".
 */
export async function fileDiff({ repo, target, path }: RpcInput<typeof fileDiffRpc>) {
  const files = parsePatch(await targetPatch(expand(repo), target, [path]), FILE_DIFF_LIMITS);
  const file = files.find((candidate) => candidate.path === path) ?? files[0] ?? null;
  if (file) await addSyntaxTokens([file]);
  return { file };
}

/**
 * Lines of `rev:path`, highlighted as a whole file so a gap that starts inside a
 * multi-line string or comment is coloured correctly. `cat-file blob` never runs
 * a textconv filter.
 */
export async function fileLines({ repo, rev, path, start, end }: RpcInput<typeof fileLinesRpc>) {
  const content = await git(expand(repo), ["cat-file", "blob", "--end-of-options", `${rev}:${path}`]);
  if (content.slice(0, 8000).includes("\0")) throw new Error("Binary file");
  const all = content.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const lines = all.slice(start - 1, end);
  let tokens: ([number, string | null][] | null)[] | null = null;
  if (lines.length && isLanguageSupported(path)) {
    const highlighted = await highlightCodeWithBudget(all.join("\n"), path, { yieldToEventLoop });
    if (highlighted) {
      tokens = lines.map((line, index) => {
        const lineTokens = highlighted[start - 1 + index];
        return lineTokens ? toRuns(lineTokens, line) : null;
      });
    }
  }
  return { lines, total: all.length, tokens };
}

export async function patchText({ repo, target }: RpcInput<typeof patchRpc>) {
  const root = expand(repo);
  let patch: string;
  if (target.kind === "commit") {
    // `format-patch -1 <merge>` does not fail: it walks into the merged branch and
    // prints one of ITS commits. So a merge gets the first-parent diff, mail-shaped.
    const parents = (await git(root, ["rev-list", "--parents", "--max-count=1", "--end-of-options", target.sha, "--"]))
      .trim().split(" ").length - 1;
    patch = await git(root, parents > 1
      ? ["show", "--format=email", "--patch", ...DIFF_FLAGS, "--diff-merges=first-parent", "--end-of-options", target.sha, "--"]
      : ["format-patch", "-1", "--stdout", "--no-base", ...DIFF_FLAGS, "--end-of-options", target.sha, "--"]);
  } else {
    patch = await targetPatch(root, target, []);
  }
  if (patch.length > MAX_PATCH_TEXT) throw new Error("Patch too large to copy");
  return { patch };
}

/** Top-level git-dir entries that mean "the commits or refs changed". `index` is not one. */
const WATCHED_NAMES = new Set(["HEAD", "ORIG_HEAD", "FETCH_HEAD", "packed-refs"]);
const DEBOUNCE_MS = 250;

/**
 * Pushes `changed` when HEAD, a ref or packed-refs changes. Watches the
 * worktree's git dir (HEAD) and the common dir (packed-refs, FETCH_HEAD) flat,
 * and `refs/` recursively; for a linked worktree, including one of a bare
 * repository, those are different directories. Changes to anything else in
 * the git dir (index, objects, logs) are ignored: staging is not a new commit.
 */
export async function watchRepo(
  { repo }: { repo: string },
  { push, signal }: Pick<PluginSubscriptionContext<{ type: "changed" }>, "push" | "signal">,
): Promise<void> {
  const root = expand(repo);
  const [gitDir = "", commonDir = ""] = (await git(root, ["rev-parse", "--git-dir", "--git-common-dir"]))
    .split("\n").map((dir) => (dir ? resolve(root, dir) : ""));
  if (signal.aborted) return;

  return new Promise<void>((done, fail) => {
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
    const changed = (filename: string | null, flat: boolean) => {
      // Git writes X.lock and renames it onto X; some watchers report only the
      // ".lock" name, so a lock counts as a change to X. `index.lock` stays ignored.
      const name = filename?.replace(/\.lock$/, "") ?? null;
      if (flat && name !== null && !WATCHED_NAMES.has(name)) return;
      clearTimeout(timer);
      timer = setTimeout(() => void push({ type: "changed" }).catch(() => {}), DEBOUNCE_MS);
    };
    const stop = (error?: Error) => {
      signal.removeEventListener("abort", onAbort);
      close();
      if (error) fail(error); else done();
    };
    const onAbort = () => stop();
    const add = (path: string, recursive: boolean, required: boolean) => {
      try {
        const watcher = watch(path, { recursive }, (_event, filename) => changed(filename, !recursive));
        watcher.on("error", (error) => stop(error));
        watchers.push(watcher);
      } catch (error) {
        if (required) throw error;
      }
    };
    try {
      add(gitDir, false, true);
      if (commonDir !== gitDir) add(commonDir, false, false);
      add(resolve(commonDir, "refs"), true, false); // absent in some odd layouts; HEAD still works
    } catch (error) {
      close();
      fail(new Error(`Cannot watch repository: ${(error as Error).message}`));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toCommit(record: string): Omit<Commit, "stats"> {
  const [sha = "", parents = "", author = "", email = "", date = "", subject = ""] = record.split(FIELD);
  return { sha, parents: parents.split(" ").filter(Boolean), author, email, date, subject };
}
