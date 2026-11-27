/**
 * Ranking for the repo picker, in the spirit of Paseo's add-project search
 * (utils/working-directory-suggestions.ts): recommended folders first in their
 * own order when nothing is typed; once something is typed, best name matches
 * first, and a typed path is offered as-is ("Open this path").
 */
export type RepoSource = "typed" | "workspace" | "project" | "agent" | "recent" | "found";

export interface RepoOption {
  path: string;
  source: RepoSource;
}

const SOURCE_ORDER: Record<RepoSource, number> = { typed: 0, workspace: 1, project: 2, agent: 3, recent: 4, found: 5 };

/** Dedupe by path, keeping the first (most specific) source. */
export function mergeOptions(groups: RepoOption[][]): RepoOption[] {
  const seen = new Set<string>();
  const result: RepoOption[] = [];
  for (const option of groups.flat()) {
    const path = option.path.replace(/\/+$/, "") || "/";
    if (seen.has(path)) continue;
    seen.add(path);
    result.push({ ...option, path });
  }
  return result;
}

export function rankRepos(options: RepoOption[], query: string, limit = 60): RepoOption[] {
  const q = query.trim().toLowerCase();
  const typed: RepoOption[] = /^[~/]/.test(query.trim()) ? [{ path: query.trim(), source: "typed" }] : [];
  if (!q) return options.slice(0, limit);
  const scored: { option: RepoOption; tier: number }[] = [];
  for (const option of options) {
    const tier = matchTier(option.path, q);
    if (tier !== null) scored.push({ option, tier });
  }
  scored.sort((a, b) =>
    a.tier - b.tier
    || SOURCE_ORDER[a.option.source] - SOURCE_ORDER[b.option.source]
    || a.option.path.length - b.option.path.length);
  const ranked = scored.map((entry) => entry.option).filter((option) => !typed.some((t) => t.path === option.path));
  return [...typed, ...ranked].slice(0, limit);
}

/** 0 exact name, 1 name prefix, 2 name substring, 3 path substring, 4 fuzzy name, 5 fuzzy path. */
export function matchTier(path: string, q: string): number | null {
  const lower = path.toLowerCase();
  const name = lower.split("/").filter(Boolean).pop() ?? lower;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (lower.includes(q)) return 3;
  if (subsequence(name, q)) return 4;
  if (subsequence(lower, q)) return 5;
  return null;
}

function subsequence(text: string, q: string): boolean {
  let at = 0;
  for (const char of text) if (char === q[at]) at += 1;
  return at === q.length;
}

/** `/Users/me/x` -> `~/x` for display. */
export function shortenPath(path: string, home: string | null): string {
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}
