/**
 * Self-check: builds a throwaway repo with the awkward cases and runs the real
 * handlers against it. Run with `bun server/patch.check.ts`; exits non-zero on failure.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileDiff, fileLines, listCommits, listRefs, parseRemoteUrl, parseShortstat, patchText, resolveRepo,
  showCommit, showRange, watchRepo,
} from "./git";
import { parsePatch, unquote } from "./patch";

const repo = mkdtempSync(join(tmpdir(), "commit-diff-check-"));
const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const write = (path: string, body: string | Buffer) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), body);
};
const commit = (message: string) => {
  run("add", "-A");
  run("commit", "-q", "-m", message);
  return run("rev-parse", "HEAD");
};

try {
  run("init", "-q", "-b", "main");
  run("config", "user.name", "Check");
  run("config", "user.email", "check@example.com");
  // Hostile-to-parsers config: the handlers must override all of it.
  run("config", "diff.noprefix", "true");
  run("config", "diff.mnemonicPrefix", "true");
  run("config", "color.ui", "always");

  assert.deepEqual((await listCommits({ repo, skip: 0, limit: 10 })).commits, [], "empty repo lists nothing");

  write("dir/a b.txt", "one\ntwo\nthree\n");
  write("gone.txt", "bye\n");
  write("tab\tname.txt", "x\n");
  write("ünï.txt", "u\n");
  write("move-me.txt", Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") + "\n");
  write("script.sh", "echo hi\n");
  const first = commit("first");

  write("dir/a b.txt", "one\nTWO\nthree\n");
  rmSync(join(repo, "gone.txt"));
  mkdirSync(join(repo, "moved b"));
  run("mv", "move-me.txt", "moved b/x.txt");
  write("moved b/x.txt", Array.from({ length: 20 }, (_, i) => (i === 3 ? "changed" : `line ${i}`)).join("\n") + "\n");
  write("img.bin", Buffer.from([0, 1, 2, 3, 0, 255]));
  chmodSync(join(repo, "script.sh"), 0o755);
  write("tab\tname.txt", "y\n");
  const second = commit("second\n\nWith a body.");

  const { root, branch } = await resolveRepo({ path: join(repo, "dir") });
  assert.equal(root, execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repo, encoding: "utf8" }).trim());
  assert.equal(branch, "main");

  const shown = await showCommit({ repo, sha: second });
  assert.equal(shown.commit.subject, "second");
  assert.equal(shown.commit.body, "With a body.");
  assert.deepEqual(shown.commit.parents, [first]);
  const byPath = Object.fromEntries(shown.files.map((file) => [file.path, file]));

  assert.equal(byPath["dir/a b.txt"]?.status, "modified");
  assert.equal(byPath["dir/a b.txt"]?.additions, 1);
  assert.equal(byPath["dir/a b.txt"]?.deletions, 1);
  assert.ok(byPath["dir/a b.txt"]?.lines?.[0]?.startsWith("@@ -1,3 +1,3 @@"));
  assert.equal(byPath["gone.txt"]?.status, "deleted");
  assert.equal(byPath["moved b/x.txt"]?.status, "renamed");
  assert.equal(byPath["moved b/x.txt"]?.oldPath, "move-me.txt");
  assert.equal(byPath["img.bin"]?.status, "added");
  assert.equal(byPath["img.bin"]?.binary, true);
  assert.equal(byPath["script.sh"]?.status, "modified", "mode-only change is listed");
  assert.deepEqual(byPath["script.sh"]?.lines, []);
  assert.equal(byPath["tab\tname.txt"]?.additions, 1, "C-quoted path is unquoted");
  assert.equal(shown.files.length, 6, JSON.stringify(Object.keys(byPath)));

  const initial = await showCommit({ repo, sha: first.slice(0, 7) });
  assert.ok(initial.files.some((file) => file.path === "ünï.txt" && file.status === "added"), "unicode path, root commit");

  // Merge: shows what the merge brought in relative to its first parent.
  run("checkout", "-q", "-b", "side", first);
  write("side.txt", "from side\n");
  commit("side work");
  run("checkout", "-q", "main");
  run("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const merged = await showCommit({ repo, sha: run("rev-parse", "HEAD") });
  assert.equal(merged.commit.parents.length, 2);
  assert.deepEqual(merged.files.map((file) => file.path), ["side.txt"]);

  const page1 = (await listCommits({ repo, skip: 0, limit: 2 })).commits;
  const page2 = (await listCommits({ repo, skip: 2, limit: 2 })).commits;
  assert.equal(page1[0]?.subject, "merge side");
  assert.equal(page1.length + page2.length, 4);
  assert.equal(new Set([...page1, ...page2].map((c) => c.sha)).size, 4, "pages do not overlap");

  await assert.rejects(showCommit({ repo, sha: "deadbeef" }), /fatal|unknown|bad/i);
  await assert.rejects(resolveRepo({ path: join(repo, "nope") }), /No such directory/);
  await assert.rejects(resolveRepo({ path: tmpdir() }), /not a git repository/i);

  // Refs: tags (annotated peeled to its commit), a remote ref, origin/HEAD dropped, current first.
  const mergeSha = run("rev-parse", "HEAD");
  run("tag", "v1", first);
  run("tag", "-a", "v2", "-m", "annotated", second);
  run("update-ref", "refs/remotes/origin/main", mergeSha);
  run("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const { refs } = await listRefs({ repo });
  assert.deepEqual(refs[0], { name: "main", kind: "branch", sha: mergeSha, current: true });
  assert.deepEqual(refs.map((ref) => `${ref.kind}:${ref.name}`), ["branch:main", "branch:side", "remote:origin/main", "tag:v1", "tag:v2"]);
  assert.equal(refs.find((ref) => ref.name === "v2")?.sha, second, "annotated tag peeled");

  assert.equal((await resolveRepo({ path: repo })).defaultBranch, "origin/main");
  assert.equal((await resolveRepo({ path: repo })).web, null, "no remote, no web");
  run("remote", "add", "origin", "https://someone:ghp_secret@github.com/org/repo.git");
  assert.deepEqual((await resolveRepo({ path: repo })).web, { url: "https://github.com/org/repo", forge: "github" });

  // Upstream + unpushed; a big file, then a commit by someone else with a regex-ish subject.
  run("branch", "-q", "--set-upstream-to=origin/main");
  write("big.txt", Array.from({ length: 4000 }, (_, i) => `row ${i}`).join("\n") + "\n");
  const bigSha = commit("big file");
  write("src/x.ts", "const a = 1;\nconst s = `multi\nline`;\nexport function f() {\n  return a;\n}\n");
  run("add", "-A");
  run("commit", "-q", "-m", "fix(x): thing", "--author", "Other Person <other@example.com>");
  const fixSha = run("rev-parse", "HEAD");

  const firstPage = await listCommits({ repo, skip: 0, limit: 50 });
  assert.equal(firstPage.upstream, "origin/main");
  assert.deepEqual(firstPage.unpushed, [fixSha, bigSha]);
  const bySubject = Object.fromEntries(firstPage.commits.map((c) => [c.subject, c]));
  assert.deepEqual(bySubject["merge side"]?.stats, { files: 1, additions: 1, deletions: 0 }, "merge vs first parent");
  assert.deepEqual(bySubject["side work"]?.stats, { files: 1, additions: 1, deletions: 0 }, "1 file changed");
  assert.deepEqual(bySubject["big file"]?.stats, { files: 1, additions: 4000, deletions: 0 });
  assert.equal(bySubject["second"]?.stats?.files, 6);
  assert.deepEqual((await listCommits({ repo, skip: 1, limit: 1 })), { commits: [firstPage.commits[1]], upstream: null, unpushed: [] });
  assert.deepEqual(parseShortstat(" 2 files changed, 3 deletions(-)"), { files: 2, additions: 0, deletions: 3 });
  assert.equal(parseShortstat(""), null);

  const subjects = async (input: Partial<Parameters<typeof listCommits>[0]>) =>
    (await listCommits({ repo, skip: 0, limit: 50, ...input })).commits.map((c) => c.subject);
  assert.deepEqual(await subjects({ filter: { grep: "FIX(X)" } }), ["fix(x): thing"], "grep: literal, case-insensitive");
  assert.deepEqual(await subjects({ filter: { grep: "fix(x" } }), ["fix(x): thing"], "grep: unbalanced paren is literal");
  assert.deepEqual(await subjects({ filter: { author: "OTHER person" } }), ["fix(x): thing"]);
  // The merge counts: against its first parent it brought side.txt in, as it is shown.
  assert.deepEqual(await subjects({ filter: { path: "side.txt" } }), ["merge side", "side work"]);
  assert.deepEqual(await subjects({ ref: "side" }), ["side work", "first"]);
  const remotePage = await listCommits({ repo, ref: "origin/main", skip: 0, limit: 1 });
  assert.equal(remotePage.commits[0]?.sha, mergeSha);
  assert.equal(remotePage.upstream, null, "a remote ref has no upstream");
  // "dir" is also a directory: without --end-of-options/-- git calls it ambiguous.
  run("branch", "dir", first);
  assert.deepEqual(await subjects({ ref: "dir" }), ["first"]);
  await assert.rejects(listCommits({ repo, ref: "nope", skip: 0, limit: 1 }), /unknown revision|bad revision|ambiguous/i);

  // Range: what main adds over origin/main, like a PR.
  const range = await showRange({ repo, base: "origin/main", head: "main" });
  assert.equal(range.mergeBase, mergeSha);
  assert.equal(range.headSha, fixSha);
  assert.deepEqual(range.commits.map((c) => c.subject), ["fix(x): thing", "big file"]);
  assert.deepEqual(range.files.map((file) => file.path).sort(), ["big.txt", "src/x.ts"]);
  assert.equal(range.files.find((file) => file.path === "big.txt")?.truncated, true, "default cut applies");
  run("checkout", "-q", "--orphan", "lone");
  run("rm", "-rq", "--cached", ".");
  write("lone.txt", "alone\n");
  run("add", "lone.txt");
  run("commit", "-q", "-m", "lone");
  run("checkout", "-q", "-f", "main");
  await assert.rejects(showRange({ repo, base: "lone", head: "main" }), /No common history between lone and main/);

  // Full file diff: past the default per-file cut, untruncated.
  for (const target of [{ kind: "commit", sha: bigSha }, { kind: "range", base: "origin/main", head: "main" }] as const) {
    const { file } = await fileDiff({ repo, target, path: "big.txt" });
    assert.equal(file?.truncated, false);
    assert.equal(file?.lines?.length, 4001);
  }
  assert.equal((await fileDiff({ repo, target: { kind: "commit", sha: bigSha }, path: "nothing" })).file, null);

  const lines = await fileLines({ repo, rev: "main", path: "src/x.ts", start: 2, end: 3 });
  assert.deepEqual(lines.lines, ["const s = `multi", "line`;"]);
  assert.equal(lines.total, 6);
  assert.equal(lines.tokens?.length, 2);
  assert.ok(lines.tokens?.[1], "line inside a template string is highlighted");
  assert.deepEqual((await fileLines({ repo, rev: "main", path: "src/x.ts", start: 10, end: 12 })).lines, []);
  await assert.rejects(fileLines({ repo, rev: "main", path: "missing.ts", start: 1, end: 1 }), /fatal|not exist|path/i);
  await assert.rejects(fileLines({ repo, rev: "main", path: "img.bin", start: 1, end: 1 }), /Binary/);

  assert.ok((await patchText({ repo, target: { kind: "commit", sha: fixSha } })).patch.startsWith(`From ${fixSha}`));
  const mergePatch = (await patchText({ repo, target: { kind: "commit", sha: mergeSha } })).patch;
  assert.ok(mergePatch.startsWith(`From ${mergeSha}`) && mergePatch.includes("diff --git a/side.txt"), "merge falls back to show");
  assert.ok((await patchText({ repo, target: { kind: "range", base: "origin/main", head: "main" } })).patch.startsWith("diff --git "));

  // Remote URL -> web page; credentials never survive.
  assert.deepEqual(parseRemoteUrl("git@github.com:org/repo.git"), { url: "https://github.com/org/repo", forge: "github" });
  assert.deepEqual(parseRemoteUrl("ssh://git@gitlab.example.com:2222/grp/sub/repo.git"), { url: "https://gitlab.example.com/grp/sub/repo", forge: "gitlab" });
  assert.deepEqual(parseRemoteUrl("https://x-access-token:ghp_abc@github.com/org/repo"), { url: "https://github.com/org/repo", forge: "github" });
  assert.deepEqual(parseRemoteUrl("https://git.example.com:8443/team/repo.git/"), { url: "https://git.example.com:8443/team/repo", forge: "other" });
  assert.equal(parseRemoteUrl("/srv/git/repo.git"), null);
  assert.equal(parseRemoteUrl("file:///srv/git/repo.git"), null);
  assert.equal(parseRemoteUrl("../other"), null);
  assert.equal(parseRemoteUrl("https://github.com/"), null);

  // Watcher: a commit pushes "changed"; aborting resolves the handler.
  const pushes: unknown[] = [];
  const controller = new AbortController();
  const watching = watchRepo({ repo }, { push: async (event) => { pushes.push(event); }, signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  write("watched.txt", "w\n");
  commit("watched");
  for (let waited = 0; !pushes.length && waited < 3000; waited += 50) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(pushes[0], { type: "changed" }, "commit seen by the watcher");
  controller.abort();
  await watching;

  // Size limits: exact counts, truncated lines.
  const big = ["diff --git a/f b/f", "--- a/f", "+++ b/f", "@@ -0,0 +1,5 @@", ...Array(5).fill("+x"),
    "diff --git a/g b/g", "--- a/g", "+++ b/g", "@@ -0,0 +1,2 @@", "+y", "+y"].join("\n");
  const [f, g] = parsePatch(big, { maxPerFile: 3, maxTotal: 4 });
  assert.equal(f?.additions, 5);
  assert.equal(f?.lines?.length, 3);
  assert.equal(f?.truncated, true);
  assert.equal(g?.lines?.length, 1, "total budget carries across files");
  assert.equal(g?.truncated, true);
  assert.equal(unquote('"\\303\\274.txt"'), "ü.txt");

  console.log("ok: all commit-diff checks passed");
} finally {
  rmSync(repo, { recursive: true, force: true });
}
