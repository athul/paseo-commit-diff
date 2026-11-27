/**
 * Finds git repositories under the home directory for the repo picker.
 *
 * Breadth-first from $HOME, at most MAX_DEPTH levels, reading directory names
 * only. A directory holding `.git` (a non-bare folder, or a file for worktrees
 * and submodules) is a repo; the walk does not descend into it, except into a
 * bare repo, whose worktrees often live inside it. Hidden folders and
 * well-known dependency/build/media folders are skipped. The walk stops at a
 * directory count or time budget so a huge home never stalls the daemon, and
 * the result is cached briefly because the picker asks on every open.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_DEPTH = 4;
const MAX_DIRECTORIES = 15_000;
const BUDGET_MS = 3_000;
const CACHE_MS = 60_000;
const MAX_REPOS = 1_000;

const SKIP = new Set([
  "node_modules", "Library", "Applications", "Movies", "Music", "Pictures", "Public",
  "vendor", "dist", "build", "target", "venv", "__pycache__", "Pods", "DerivedData",
]);

type Result = { home: string; repos: string[]; truncated: boolean };
let cached: { at: number; result: Promise<Result> } | null = null;

export function discoverRepos(): Promise<Result> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.result;
  const result = walk(homedir());
  cached = { at: Date.now(), result };
  // A failed walk must not be served from cache.
  result.catch(() => { cached = null; });
  return result;
}

export async function walk(root: string, limits = { depth: MAX_DEPTH, directories: MAX_DIRECTORIES, ms: BUDGET_MS }): Promise<Result> {
  const deadline = Date.now() + limits.ms;
  const repos: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  let scanned = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (scanned >= limits.directories || Date.now() > deadline || repos.length >= MAX_REPOS) {
      truncated = true;
      break;
    }
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    scanned += 1;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, vanished: not a repo we can open anyway
    }
    const git = entries.find((entry) => entry.name === ".git");
    if (git?.isFile()) {
      // Worktree or submodule: `.git` is a "gitdir:" pointer; git opens it as a work tree.
      repos.push(dir);
      continue;
    }
    if (git?.isDirectory()) {
      // A bare repo (core.bare) cannot be opened as a work tree, but its
      // worktrees often live inside it: keep walking instead of listing it.
      if (!(await isBare(join(dir, ".git")))) {
        repos.push(dir);
        continue;
      }
    }
    if (depth >= limits.depth) continue;
    for (const entry of entries) {
      // isDirectory() is false for symlinks, so links cannot loop the walk.
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      queue.push({ dir: join(dir, entry.name), depth: depth + 1 });
    }
  }
  repos.sort((a, b) => a.localeCompare(b));
  return { home: root, repos, truncated };
}

async function isBare(gitDir: string): Promise<boolean> {
  const config = await readFile(join(gitDir, "config"), "utf8").catch(() => "");
  return /^\s*bare\s*=\s*true\s*$/im.test(config);
}
