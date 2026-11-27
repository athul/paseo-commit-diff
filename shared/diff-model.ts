/**
 * Pure diff layout: turns parsed files into the flat rows the virtualised list
 * draws. No React, no I/O, so it is checked directly (server/diff-model.check.ts).
 *
 * Layout follows Paseo's viewer (packages/app/src/utils/diff-layout.ts):
 *  - unified: one gutter, removals show the old number, the rest the new one;
 *  - split: context on both sides, a run of removals paired index-by-index with
 *    the run of additions that follows it.
 * On top of that: changed-file tree, expandable gaps between hunks ("show more
 * context"), and intra-line word changes for paired removal/addition lines.
 */
import type { CommitFilter, FileDiff } from "./git";

export type Runs = [number, string | null][];
export type CellType = "add" | "remove" | "context";

export interface Cell {
  type: CellType;
  number: number | null;
  text: string;
  runs: Runs | null;
  /** Char ranges [start, end) that differ from the paired line, or null. */
  changes: [number, number][] | null;
}

/** Hidden unchanged lines between hunks, in new-file numbering. */
export interface Gap {
  key: string;
  oldStart: number;
  newStart: number;
  /** Null for the tail after the last hunk: its length is unknown until fetched. */
  count: number | null;
}

/** Context lines fetched for a gap, starting at the gap's newStart. */
export interface Expansion {
  lines: string[];
  runs: (Runs | null)[] | null;
  /** The file's total line count (from file.lines), bounding the tail gap. */
  total: number;
}

export type DiffRow =
  | { kind: "dir"; key: string; name: string; depth: number }
  | { kind: "entry"; key: string; file: number; name: string; depth: number }
  | { kind: "file"; key: string; file: number }
  | { kind: "hunk"; key: string; file: number; text: string }
  | { kind: "gap"; key: string; file: number; gap: Gap; hidden: number | null }
  | { kind: "unified"; key: string; file: number; cell: Cell }
  | { kind: "split"; key: string; file: number; left: Cell | null; right: Cell | null }
  | { kind: "note"; key: string; file: number; text: string; action: "load" | null };

export interface LayoutInput {
  files: FileDiff[];
  collapsed: ReadonlySet<number>;
  layout: "unified" | "split";
  expansions: ReadonlyMap<string, Expansion>;
  /** Gaps can only be filled for these files (not added/deleted/binary/truncated). */
  canExpand: (file: FileDiff) => boolean;
}

export function buildRows(input: LayoutInput): DiffRow[] {
  const rows: DiffRow[] = [...fileTree(input.files)];
  input.files.forEach((file, index) => {
    rows.push({ kind: "file", key: `file-${index}`, file: index });
    if (input.collapsed.has(index)) return;
    rows.push(...fileBody(file, index, input));
  });
  return rows;
}

/** Max line number shown in a file's gutter, for gutter width. */
export function maxLineNumber(rows: DiffRow[], file: number): number {
  let max = 0;
  for (const row of rows) {
    if (row.kind === "unified" && row.file === file) max = Math.max(max, row.cell.number ?? 0);
    if (row.kind === "split" && row.file === file) max = Math.max(max, row.left?.number ?? 0, row.right?.number ?? 0);
  }
  return max;
}

// ---------------------------------------------------------------------------
// Changed-file tree (folders first-seen order, single-child folders compressed)
// ---------------------------------------------------------------------------

interface Dir { name: string; dirs: Map<string, Dir>; files: { index: number; name: string }[] }

export function fileTree(files: FileDiff[]): DiffRow[] {
  const root: Dir = { name: "", dirs: new Map(), files: [] };
  files.forEach((file, index) => {
    const parts = file.path.split("/");
    const name = parts.pop() ?? file.path;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) dir.dirs.set(part, (next = { name: part, dirs: new Map(), files: [] }));
      dir = next;
    }
    dir.files.push({ index, name });
  });
  const rows: DiffRow[] = [];
  const walk = (dir: Dir, depth: number, prefix: string) => {
    for (const child of dir.dirs.values()) {
      // Compress a/b/c when a and b hold nothing but the next folder.
      let node = child;
      let name = child.name;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const only = [...node.dirs.values()][0] as Dir;
        name = `${name}/${only.name}`;
        node = only;
      }
      const path = `${prefix}${name}`;
      rows.push({ kind: "dir", key: `dir-${path}`, name, depth });
      walk(node, depth + 1, `${path}/`);
    }
    for (const file of dir.files) {
      rows.push({ kind: "entry", key: `entry-${file.index}`, file: file.index, name: file.name, depth });
    }
  };
  walk(root, 0, "");
  return rows;
}

// ---------------------------------------------------------------------------
// One file's body
// ---------------------------------------------------------------------------

interface Hunk { header: string; oldStart: number; oldCount: number; newStart: number; newCount: number; lines: number[] }

function hunks(file: FileDiff): Hunk[] {
  const result: Hunk[] = [];
  (file.lines ?? []).forEach((line, index) => {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      result.push({
        header: line,
        oldStart: Number(match?.[1] ?? 1),
        oldCount: match?.[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match?.[3] ?? 1),
        newCount: match?.[4] === undefined ? 1 : Number(match[4]),
        lines: [],
      });
    } else {
      result[result.length - 1]?.lines.push(index);
    }
  });
  return result;
}

function fileBody(file: FileDiff, index: number, input: LayoutInput): DiffRow[] {
  const rows: DiffRow[] = [];
  if (file.binary) return [{ kind: "note", key: `${index}-bin`, file: index, text: "Binary file not shown", action: null }];
  if (file.lines?.length === 0) return [{ kind: "note", key: `${index}-empty`, file: index, text: "No content changes", action: null }];
  if (file.lines === null) {
    return [{ kind: "note", key: `${index}-cut`, file: index, text: "Diff too large to show", action: "load" }];
  }
  const expandable = input.canExpand(file);
  const list = hunks(file);
  let oldNext = 1;
  let newNext = 1;
  list.forEach((hunk, h) => {
    // "+L,0" (nothing on the new side) sits *after* line L, so L itself is still unchanged.
    const firstNew = hunk.newCount === 0 ? hunk.newStart + 1 : hunk.newStart;
    if (expandable) rows.push(...gapRows(index, `${index}-gap-${h}`, oldNext, newNext, firstNew - newNext, input));
    rows.push({ kind: "hunk", key: `${index}-h${h}`, file: index, text: hunk.header });
    rows.push(...hunkRows(file, index, hunk, input.layout));
    oldNext = hunk.oldStart + hunk.oldCount;
    newNext = hunk.newStart + hunk.newCount;
    // A zero-length side starts *after* its start line (e.g. "-0,0").
    if (hunk.oldCount === 0) oldNext = hunk.oldStart + 1;
    if (hunk.newCount === 0) newNext = hunk.newStart + 1;
  });
  if (expandable && list.length > 0) rows.push(...gapRows(index, `${index}-gap-end`, oldNext, newNext, null, input));
  if (file.truncated) rows.push({ kind: "note", key: `${index}-cut`, file: index, text: "Diff too large: the rest of this file is not shown", action: "load" });
  return rows;
}

/** Expanded context lines (if fetched) followed by a gap row for whatever is still hidden. */
function gapRows(file: number, key: string, oldStart: number, newStart: number, count: number | null, input: LayoutInput): DiffRow[] {
  if (count !== null && count <= 0) return [];
  const expansion = input.expansions.get(key);
  const rows: DiffRow[] = [];
  let shown = 0;
  if (expansion) {
    const limit = count ?? Math.max(0, expansion.total - newStart + 1);
    const lines = expansion.lines.slice(0, limit);
    lines.forEach((text, i) => {
      const left: Cell = { type: "context", number: oldStart + i, text, runs: expansion.runs?.[i] ?? null, changes: null };
      const right: Cell = { ...left, number: newStart + i };
      rows.push(input.layout === "split"
        ? { kind: "split", key: `${key}-x${i}`, file, left, right }
        : { kind: "unified", key: `${key}-x${i}`, file, cell: right });
    });
    shown = lines.length;
    const remaining = (count ?? Math.max(0, expansion.total - newStart + 1)) - shown;
    if (remaining <= 0) return rows;
    rows.push({
      kind: "gap", key, file,
      gap: { key, oldStart: oldStart + shown, newStart: newStart + shown, count: remaining },
      hidden: remaining,
    });
    return rows;
  }
  rows.push({ kind: "gap", key, file, gap: { key, oldStart, newStart, count }, hidden: count });
  return rows;
}

function hunkRows(file: FileDiff, index: number, hunk: Hunk, layout: "unified" | "split"): DiffRow[] {
  const lines = file.lines ?? [];
  const rows: DiffRow[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let removes: Cell[] = [];
  let adds: Cell[] = [];
  let keySeq = 0;
  const key = () => `${index}-l${hunk.lines[0] ?? 0}-${keySeq++}`;

  const flush = () => {
    markWordChanges(removes, adds);
    if (layout === "split") {
      for (let i = 0; i < Math.max(removes.length, adds.length); i += 1) {
        rows.push({ kind: "split", key: key(), file: index, left: removes[i] ?? null, right: adds[i] ?? null });
      }
    } else {
      for (const cell of [...removes, ...adds]) rows.push({ kind: "unified", key: key(), file: index, cell });
    }
    removes = [];
    adds = [];
  };

  for (const lineIndex of hunk.lines) {
    const raw = lines[lineIndex] ?? "";
    const sign = raw[0];
    const runs = file.tokens?.[lineIndex] ?? null;
    if (sign === "\\") {
      flush();
      rows.push({ kind: "hunk", key: key(), file: index, text: raw.slice(2) });
    } else if (sign === "-") {
      if (adds.length) flush();
      removes.push({ type: "remove", number: oldNo++, text: raw.slice(1), runs, changes: null });
    } else if (sign === "+") {
      adds.push({ type: "add", number: newNo++, text: raw.slice(1), runs, changes: null });
    } else {
      flush();
      const left: Cell = { type: "context", number: oldNo++, text: raw.slice(1), runs, changes: null };
      const right: Cell = { ...left, number: newNo++ };
      rows.push(layout === "split"
        ? { kind: "split", key: key(), file: index, left, right }
        : { kind: "unified", key: key(), file: index, cell: right });
    }
  }
  flush();
  return rows;
}

// ---------------------------------------------------------------------------
// Intra-line word changes
// ---------------------------------------------------------------------------

const MAX_TOKENS = 400;

/** Pair removals with additions index-by-index and mark the differing words. */
export function markWordChanges(removes: Cell[], adds: Cell[]): void {
  const pairs = Math.min(removes.length, adds.length);
  for (let i = 0; i < pairs; i += 1) {
    const before = removes[i] as Cell;
    const after = adds[i] as Cell;
    const result = wordDiff(before.text, after.text);
    if (!result) continue;
    before.changes = result.before;
    after.changes = result.after;
  }
}

/**
 * Token-level LCS. Null when the lines share too little to make word marks
 * meaningful (then the whole-line colour says it all, as on GitHub), or are
 * too long to diff cheaply.
 */
export function wordDiff(a: string, b: string): { before: [number, number][]; after: [number, number][] } | null {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.length === 0 || right.length === 0 || left.length > MAX_TOKENS || right.length > MAX_TOKENS) return null;
  const n = left.length;
  const m = right.length;
  const table: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i]![j] = left[i]!.text === right[j]!.text
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const keepLeft = new Set<number>();
  const keepRight = new Set<number>();
  let common = 0;
  for (let i = 0, j = 0; i < n && j < m;) {
    if (left[i]!.text === right[j]!.text) {
      keepLeft.add(i);
      keepRight.add(j);
      if (left[i]!.text.trim()) common += left[i]!.text.length;
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i += 1;
    else j += 1;
  }
  const significant = Math.max(a.trim().length, b.trim().length);
  if (significant === 0 || common / significant < 0.3) return null;
  const before = ranges(left, keepLeft);
  const after = ranges(right, keepRight);
  if (before.length === 0 && after.length === 0) return null;
  return { before, after };
}

interface Token { text: string; start: number }

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\w+|\s+|[^\w\s]/g)) tokens.push({ text: match[0], start: match.index ?? 0 });
  return tokens;
}

/** Merge adjacent unkept tokens into ranges; whitespace between two changes joins them. */
function ranges(tokens: Token[], keep: Set<number>): [number, number][] {
  const result: [number, number][] = [];
  tokens.forEach((token, index) => {
    if (keep.has(index)) return;
    const start = token.start;
    const end = token.start + token.text.length;
    const last = result[result.length - 1];
    const gap = last ? tokens.slice(0, index).filter((t) => t.start >= last[1] && t.start < start) : [];
    if (last && gap.every((t) => !t.text.trim())) last[1] = end;
    else result.push([start, end]);
  });
  return result.filter(([start, end]) => end > start);
}

// ---------------------------------------------------------------------------
// Rendering segments: syntax runs x word changes
// ---------------------------------------------------------------------------

export interface Segment { text: string; style: string | null; changed: boolean }

/** Split a line at every syntax-run and change boundary. */
export function segments(text: string, runs: Runs | null, changes: [number, number][] | null): Segment[] {
  const cuts = new Set<number>([0, text.length]);
  let offset = 0;
  const styleAt: { start: number; end: number; style: string | null }[] = [];
  for (const [length, style] of runs ?? [[text.length, null]]) {
    styleAt.push({ start: offset, end: offset + length, style });
    offset += length;
    cuts.add(Math.min(offset, text.length));
  }
  for (const [start, end] of changes ?? []) {
    cuts.add(Math.max(0, Math.min(start, text.length)));
    cuts.add(Math.max(0, Math.min(end, text.length)));
  }
  const points = [...cuts].sort((x, y) => x - y);
  const result: Segment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    if (end <= start) continue;
    const style = styleAt.find((run) => start >= run.start && start < run.end)?.style ?? null;
    const changed = (changes ?? []).some(([s, e]) => start >= s && start < e);
    const last = result[result.length - 1];
    if (last && last.style === style && last.changed === changed) last.text += text.slice(start, end);
    else result.push({ text: text.slice(start, end), style, changed });
  }
  return result;
}

/**
 * `author:x path:y free text` -> CommitFilter. Values may be quoted:
 * path:"a b/c.ts". Everything else is the message search.
 */
export function parseFilter(text: string): CommitFilter | undefined {
  const filter: CommitFilter = {};
  const rest: string[] = [];
  for (const match of text.matchAll(/(\w+):"([^"]*)"|(\w+):(\S+)|("[^"]*"|\S+)/g)) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    if (key === "author" && value) filter.author = value;
    else if (key === "path" && value) filter.path = value;
    else rest.push((match[5] ?? match[0]).replace(/^"|"$/g, ""));
  }
  if (rest.length) filter.grep = rest.join(" ");
  return filter.grep || filter.author || filter.path ? filter : undefined;
}
