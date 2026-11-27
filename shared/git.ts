/**
 * Contracts between the commit-diff panel (app) and its daemon handlers.
 *
 * The daemon owns every git call; the app only ever sends a repository path and
 * a commit hash, both validated here so a bad value never reaches `git`.
 */
import { defineRpc, defineSettings, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/** An absolute path (or `~/...`) on the daemon machine. No NUL: it becomes a cwd. */
const RepoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"), "Path contains a NUL byte")
  .refine((path) => path.startsWith("/") || path.startsWith("~"), "Use an absolute path");

/** Hex only, so it can never be read by git as an option or a revision expression. */
const CommitHash = z.string().regex(/^[0-9a-f]{7,40}$/i, "Not a commit hash");

/**
 * A branch, tag, remote branch or commit hash. Never starts with "-" (option),
 * never contains ".." (range) or ":" (rev:path), and is passed after
 * `--end-of-options` as well. Ranges are built server-side from two of these.
 */
const Rev = z
  .string()
  .min(1)
  .max(256)
  .regex(/^(?!-)[A-Za-z0-9._/@{}^~+-]+$/, "Not a revision")
  .refine((rev) => !rev.includes(".."), "Not a revision");

/** A path inside the repo, relative to its root. Always passed after `--`. */
const FilePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((path) => !path.includes("\0"), "Path contains a NUL byte");

/** What a diff is of: one commit, or `base...head` (merge-base, like a pull request). */
export const DiffTarget = z.union([
  z.object({ kind: z.literal("commit"), sha: CommitHash }),
  z.object({ kind: z.literal("range"), base: Rev, head: Rev }),
]);
export type DiffTarget = z.infer<typeof DiffTarget>;

export const CommitSchema = z.object({
  sha: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  email: z.string(),
  date: z.string(),
  subject: z.string(),
  /** `--shortstat` (merges: against the first parent). Null when git printed none. */
  stats: z.object({ files: z.number(), additions: z.number(), deletions: z.number() }).nullable(),
});
export type Commit = z.infer<typeof CommitSchema>;

export const FileDiffSchema = z.object({
  path: z.string(),
  /** Set for renames and copies. */
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied"]),
  additions: z.number(),
  deletions: z.number(),
  binary: z.boolean(),
  /** Hunk lines (`@@`, ` `, `+`, `-`, `\`), or null when omitted for size. */
  lines: z.array(z.string()).nullable(),
  /** True when some or all of this file's lines were left out for size. */
  truncated: z.boolean(),
  /**
   * Syntax tokens per line, aligned with `lines`: `[length, style]` runs over the
   * line's code (after the +/-/space marker). Null per line for hunk headers, and
   * for the whole file when the language is unsupported or the file is too big.
   */
  tokens: z.array(z.array(z.tuple([z.number(), z.string().nullable()])).nullable()).nullable(),
});
export type FileDiff = z.infer<typeof FileDiffSchema>;

export const resolveRepoRpc = defineRpc({
  name: "repo.resolve",
  input: z.object({ path: RepoPath }),
  output: z.object({
    root: z.string(),
    branch: z.string().nullable(),
    /** origin/HEAD's branch, else main/master if present: the "compare with" default. */
    defaultBranch: z.string().nullable(),
    /**
     * Web URL of the remote (origin, else the first remote), credentials stripped,
     * e.g. https://github.com/org/repo. Null when it is not an http(s)/ssh forge URL.
     */
    web: z.object({ url: z.string(), forge: z.enum(["github", "gitlab", "other"]) }).nullable(),
  }),
});

export const RefSchema = z.object({
  /** Short name as git log accepts it: "main", "origin/main", "v1.2.0". */
  name: z.string(),
  kind: z.enum(["branch", "remote", "tag"]),
  sha: z.string(),
  /** The checked-out branch. */
  current: z.boolean(),
});
export type GitRef = z.infer<typeof RefSchema>;

export const listRefsRpc = defineRpc({
  name: "refs.list",
  input: z.object({ repo: RepoPath }),
  output: z.object({ refs: z.array(RefSchema) }),
});

export const CommitFilter = z.object({
  /** Case-insensitive substring of the message (`--grep -i -F`). */
  grep: z.string().max(200).optional(),
  /** Case-insensitive substring of author name/email (`--author -i -F`). */
  author: z.string().max(200).optional(),
  /** Only commits touching this path (`-- path`); a file's history. */
  path: FilePath.optional(),
});
export type CommitFilter = z.infer<typeof CommitFilter>;

export const listCommitsRpc = defineRpc({
  name: "commits.list",
  input: z.object({
    repo: RepoPath,
    /** Defaults to HEAD. */
    ref: Rev.optional(),
    filter: CommitFilter.optional(),
    skip: z.number().int().min(0).max(1_000_000),
    limit: z.number().int().min(1).max(200),
  }),
  output: z.object({
    commits: z.array(CommitSchema),
    /** The ref's upstream ("origin/main"), only on the first page (skip 0). */
    upstream: z.string().nullable(),
    /** Commits on the ref but not its upstream (max 500), only on the first page. */
    unpushed: z.array(z.string()),
  }),
});

export const showCommitRpc = defineRpc({
  name: "commit.show",
  input: z.object({ repo: RepoPath, sha: CommitHash }),
  output: z.object({
    commit: CommitSchema.extend({ body: z.string() }),
    files: z.array(FileDiffSchema),
  }),
});

export const showRangeRpc = defineRpc({
  name: "range.show",
  input: z.object({ repo: RepoPath, base: Rev, head: Rev }),
  output: z.object({
    baseSha: z.string(),
    headSha: z.string(),
    mergeBase: z.string(),
    /** `base..head`, newest first, max 500. */
    commits: z.array(CommitSchema),
    /** `git diff mergeBase head`: what the head adds, like a pull request. */
    files: z.array(FileDiffSchema),
  }),
});

/** One file's diff without the size cut (a much larger cap), for "Load full diff". */
export const fileDiffRpc = defineRpc({
  name: "file.diff",
  input: z.object({ repo: RepoPath, target: DiffTarget, path: FilePath }),
  output: z.object({ file: FileDiffSchema.nullable() }),
});

/**
 * Lines `start..end` (1-based, inclusive, at most 2000) of a file at a revision,
 * with syntax runs, for "show more context" between hunks. `total` is the file's
 * line count, so the client knows how far the last gap reaches.
 */
export const fileLinesRpc = defineRpc({
  name: "file.lines",
  input: z
    .object({
      repo: RepoPath,
      rev: Rev,
      path: FilePath,
      start: z.number().int().min(1),
      end: z.number().int().min(1),
    })
    .refine(({ start, end }) => end >= start && end - start < 2000, "Bad line range"),
  output: z.object({
    lines: z.array(z.string()),
    total: z.number(),
    tokens: z.array(z.array(z.tuple([z.number(), z.string().nullable()])).nullable()).nullable(),
  }),
});

/** The whole patch as text, for copying (`format-patch` for a commit, `diff` for a range). */
export const patchRpc = defineRpc({
  name: "patch.text",
  input: z.object({ repo: RepoPath, target: DiffTarget }),
  output: z.object({ patch: z.string() }),
});

/**
 * Pushes `changed` whenever HEAD, a ref or packed-refs changes (commit, checkout,
 * fetch, push), debounced. Replaces polling.
 */
export const watchRepoSubscription = defineSubscription({
  name: "repo.watch",
  input: z.object({ repo: RepoPath }),
  event: z.object({ type: z.literal("changed") }),
});

/**
 * Git repositories found under the daemon user's home directory, for the repo
 * picker's suggestions. Only directory names are read (no file contents); the
 * scan is depth- and time-bounded and skips hidden, dependency and build folders.
 */
export const discoverReposRpc = defineRpc({
  name: "repos.discover",
  input: z.object({}),
  output: z.object({
    home: z.string(),
    repos: z.array(z.string()),
    /** The scan hit its time or size limit; deeper repos may be missing. */
    truncated: z.boolean(),
  }),
});

/** Repositories recently opened in the panel, newest first, shared across workspaces. */
export const recentReposSettings = defineSettings({
  id: "recent-repos",
  scope: "host",
  version: 1,
  schema: z.object({ repos: z.array(z.string()).max(10).default([]) }),
});

/** @getpaseo/highlight SYNTAX_THEME_OPTIONS, inlined: client bundles cannot import it. */
export const SYNTAX_THEMES = [
  { value: "one", label: "One" },
  { value: "github", label: "GitHub" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "dracula", label: "Dracula" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "nord", label: "Nord" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "solarized", label: "Solarized" },
] as const;
const SyntaxTheme = z.enum(["one", "github", "catppuccin", "dracula", "tokyo-night", "nord", "gruvbox", "solarized"]);
export type SyntaxTheme = z.infer<typeof SyntaxTheme>;

/**
 * Mirrors Paseo's Appearance > code font, code size and syntax theme, which are
 * app-local and not readable by plugins. Defaults are Paseo's: "" (its default
 * mono stack), 12px, "one".
 */
export const appearanceSettings = defineSettings({
  id: "appearance",
  scope: "host",
  version: 1,
  schema: z.object({
    codeFontFamily: z.string().max(200).default(""),
    codeFontSize: z.number().int().min(8).max(32).default(12),
    syntaxTheme: SyntaxTheme.default("one"),
    /** Paseo's diff layout preference: one column, or old | new side by side (wide only). */
    diffLayout: z.enum(["unified", "split"]).default("unified"),
    /** Wrap long lines (true) or scroll them sideways (false). */
    wrapLines: z.boolean().default(true),
  }),
});

/** Paseo's `resolveSyntaxColors(theme, scheme)`: token style -> colour. */
export const syntaxPaletteRpc = defineRpc({
  name: "syntax.palette",
  input: z.object({ theme: SyntaxTheme, scheme: z.enum(["light", "dark"]) }),
  output: z.object({ colors: z.record(z.string(), z.string()) }),
});
