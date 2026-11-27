/**
 * Splits `git show --patch` output into one entry per file, GitHub-style.
 *
 * Paths come from the unambiguous header lines (`rename from/to`, `--- a/`,
 * `+++ b/`) and only fall back to the `diff --git` line, which is ambiguous
 * when a path contains " b/". Git C-quotes unusual paths ("a/x\ty"); those are
 * unquoted byte-for-byte. The caller forces `a/`/`b/` prefixes, so the user's
 * `diff.noprefix` / `diff.mnemonicPrefix` config cannot change what we parse.
 *
 * Size: counts are always exact, but only `maxPerFile` lines per file and
 * `maxTotal` lines per commit are kept; the rest is marked `truncated`.
 */
import type { FileDiff } from "../shared/git";

export const DEFAULT_LIMITS = { maxPerFile: 3000, maxTotal: 20000 };

interface Draft extends FileDiff {
  gitLine: string;
  minus: string | null | undefined;
  plus: string | null | undefined;
  inHunk: boolean;
}

export function parsePatch(text: string, limits = DEFAULT_LIMITS): FileDiff[] {
  const drafts: Draft[] = [];
  let budget = limits.maxTotal;
  let current: Draft | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = {
        path: "", oldPath: null, status: "modified", additions: 0, deletions: 0,
        binary: false, lines: [], truncated: false, tokens: null,
        gitLine: line, minus: undefined, plus: undefined, inHunk: false,
      };
      drafts.push(current);
      continue;
    }
    if (!current) continue;

    if (line.startsWith("@@")) current.inHunk = true;
    if (current.inHunk) {
      const kind = line[0];
      if (kind !== "@" && kind !== " " && kind !== "+" && kind !== "-" && kind !== "\\") continue;
      if (kind === "+") current.additions += 1;
      if (kind === "-") current.deletions += 1;
      keep(current, line);
      continue;
    }

    // Extended header, before the first hunk.
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "deleted";
    else if (line.startsWith("rename from ")) { current.status = "renamed"; current.oldPath = unquote(line.slice(12)); }
    else if (line.startsWith("rename to ")) current.path = unquote(line.slice(10));
    else if (line.startsWith("copy from ")) { current.status = "copied"; current.oldPath = unquote(line.slice(10)); }
    else if (line.startsWith("copy to ")) current.path = unquote(line.slice(8));
    else if (line.startsWith("--- ")) current.minus = side(line.slice(4), "a/");
    else if (line.startsWith("+++ ")) current.plus = side(line.slice(4), "b/");
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") current.binary = true;
  }

  function keep(file: Draft, line: string): void {
    if (!file.lines) return;
    if (file.lines.length >= limits.maxPerFile || budget <= 0) {
      file.truncated = true;
      if (file.lines.length === 0) file.lines = null;
      return;
    }
    file.lines.push(line);
    budget -= 1;
  }

  return drafts.map(({ gitLine, minus, plus, inHunk: _inHunk, ...file }) => {
    if (!file.path) {
      const [a, b] = splitGitLine(gitLine);
      file.path = plus ?? minus ?? b ?? a ?? gitLine;
    }
    if (file.status === "modified" && minus && plus && minus !== plus) {
      file.status = "renamed";
    }
    if ((file.status === "renamed" || file.status === "copied") && !file.oldPath) {
      file.oldPath = minus ?? null;
    }
    return file;
  });
}

/** `a/path`, `"a/pa\tth"` or `/dev/null` -> the bare path, or null for /dev/null. */
function side(raw: string, prefix: string): string | null {
  const value = unquote(raw.replace(/\t$/, ""));
  if (value === "/dev/null") return null;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

/** Best effort for headers with no ---/+++ (binary, mode-only): the paths of `diff --git a/X b/Y`. */
function splitGitLine(line: string): [string | undefined, string | undefined] {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = closingQuote(rest);
    const a = unquote(rest.slice(0, end + 1));
    const b = unquote(rest.slice(end + 2));
    return [strip(a, "a/"), strip(b, "b/")];
  }
  if (rest.endsWith('"')) {
    const start = rest.lastIndexOf(' "');
    return [strip(rest.slice(0, start), "a/"), strip(unquote(rest.slice(start + 1)), "b/")];
  }
  // Unquoted and same name on both sides (the only case without ---/+++ or rename lines).
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half)) {
    const a = strip(rest.slice(0, half), "a/");
    const b = strip(rest.slice(half + 1), "b/");
    if (a === b) return [a, b];
  }
  return [undefined, undefined];
}

function strip(value: string, prefix: string): string {
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function closingQuote(text: string): number {
  for (let index = 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === '"') return index;
  }
  return text.length - 1;
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Undo git's C-style path quoting; octal escapes are UTF-8 bytes. */
export function unquote(value: string): string {
  if (!(value.length >= 2 && value.startsWith('"') && value.endsWith('"'))) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      continue;
    }
    const next = body[index + 1] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.slice(index + 1, index + 4), 8));
      index += 3;
    } else {
      bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
      index += 1;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
