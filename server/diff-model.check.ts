/** Self-check for shared/diff-model.ts. Run with `bun server/diff-model.check.ts`. */
import assert from "node:assert/strict";
import { buildRows, type Expansion, fileTree, parseFilter, segments, wordDiff } from "../shared/diff-model";
import type { FileDiff } from "../shared/git";

const file = (path: string, lines: string[] | null, extra: Partial<FileDiff> = {}): FileDiff => ({
  path, oldPath: null, status: "modified", additions: 0, deletions: 0, binary: false,
  lines, truncated: false, tokens: null, ...extra,
});

// Tree: folders before files, single-child chains compressed, depth.
const tree = fileTree([file("a/b/c/x.ts", []), file("a/b/c/y.ts", []), file("a/z.ts", []), file("root.md", [])]);
assert.deepEqual(tree.map((r) => (r.kind === "dir" ? `D${r.depth}:${r.name}` : r.kind === "entry" ? `F${r.depth}:${r.name}` : r.kind)),
  ["D0:a", "D1:b/c", "F2:x.ts", "F2:y.ts", "F1:z.ts", "F0:root.md"]);

// Word diff: one changed word marked on both sides; unrelated lines -> null.
const wd = wordDiff("const total = price * qty;", "const total = cost * qty;");
assert.deepEqual(wd, { before: [[14, 19]], after: [[14, 18]] });
assert.equal(wordDiff("alpha beta gamma", "completely different words here"), null);

// Segments: syntax runs x changes.
assert.deepEqual(segments("abcdef", [[3, "keyword"], [3, null]], [[2, 4]]), [
  { text: "ab", style: "keyword", changed: false },
  { text: "c", style: "keyword", changed: true },
  { text: "d", style: null, changed: true },
  { text: "ef", style: null, changed: false },
]);

// Body: unified numbering, gaps before/between/after hunks, word marks.
const f = file("src/x.ts", [
  "@@ -3,3 +3,3 @@ fn",
  " keep",
  "-let a = 1;",
  "+let a = 2;",
  "@@ -20,2 +20,3 @@",
  " tail",
  "+added",
  " end",
]);
const base = { collapsed: new Set<number>(), expansions: new Map<string, Expansion>(), canExpand: () => true };
const unified = buildRows({ ...base, files: [f], layout: "unified" });
const body = unified.filter((r) => "file" in r && r.file === 0 && r.kind !== "entry");
const describe = (r: (typeof unified)[number]) =>
  r.kind === "gap" ? `gap@${r.gap.newStart}:${r.hidden}` :
  r.kind === "unified" ? `${r.cell.type[0]}${r.cell.number}` :
  r.kind === "hunk" ? "@@" : r.kind;
assert.deepEqual(body.map(describe), ["file", "gap@1:2", "@@", "c3", "r4", "a4", "gap@6:14", "@@", "c20", "a21", "c22", "gap@23:null"]);
const removed = body.find((r) => r.kind === "unified" && r.cell.type === "remove");
assert.ok(removed?.kind === "unified" && removed.cell.changes?.length === 1, "word change marked");

// Split: remove/add paired on one row; context on both sides.
const split = buildRows({ ...base, files: [f], layout: "split" }).filter((r) => r.kind === "split");
assert.deepEqual(split.map((r) => (r.kind === "split" ? `${r.left?.number ?? "-"}|${r.right?.number ?? "-"}` : "")),
  ["3|3", "4|4", "20|20", "-|21", "21|22"]);

// Expanding the middle gap partially leaves the rest hidden; the tail uses total.
const expansions = new Map<string, Expansion>([
  ["0-gap-1", { lines: ["l6", "l7", "l8"], runs: null, total: 30 }],
  ["0-gap-end", { lines: ["l23", "l24"], runs: null, total: 24 }],
]);
const expanded = buildRows({ ...base, expansions, files: [f], layout: "unified" }).filter((r) => "file" in r && r.file === 0 && r.kind !== "entry");
assert.deepEqual(expanded.map(describe).slice(6), ["c6", "c7", "c8", "gap@9:11", "@@", "c20", "a21", "c22", "c23", "c24"]);
const c7 = expanded.find((r) => r.kind === "unified" && r.cell.text === "l7");
assert.ok(c7?.kind === "unified" && c7.cell.number === 7);

// Pure deletion hunk "+L,0": the gap before it includes line L.
const del = file("d.ts", ["@@ -5,2 +4,0 @@", "-x", "-y"]);
const delRows = buildRows({ ...base, files: [del], layout: "unified" }).filter((r) => r.kind === "gap");
assert.equal(delRows[0]?.kind === "gap" && delRows[0].hidden, 4);

// Collapsed, binary, null lines.
assert.equal(buildRows({ ...base, collapsed: new Set([0]), files: [f], layout: "unified" }).filter((r) => "file" in r && r.file === 0).length, 2);
assert.equal(buildRows({ ...base, files: [file("b.png", [], { binary: true })], layout: "unified" }).at(-1)?.kind, "note");
const cut = buildRows({ ...base, files: [file("big.ts", null, { truncated: true })], layout: "unified" }).at(-1);
assert.ok(cut?.kind === "note" && cut.action === "load");

// Search syntax.
assert.deepEqual(parseFilter('fix login author:jane path:"src/a b.ts"'), { grep: "fix login", author: "jane", path: "src/a b.ts" });
assert.deepEqual(parseFilter("path:main.py"), { path: "main.py" });
assert.deepEqual(parseFilter('"exact phrase" more'), { grep: "exact phrase more" });
assert.equal(parseFilter("   "), undefined);

console.log("ok: diff-model checks passed");
