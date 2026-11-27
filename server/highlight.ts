/**
 * Syntax tokens for diff lines, done the way Paseo's own diff does it
 * (packages/app/src/utils/diff-highlight.ts): rebuild the old and new code from
 * the diff lines by position, highlight each as one document with
 * @getpaseo/highlight (so multi-line strings/comments inside a hunk are right),
 * then map tokens back to lines. Context outside the hunks is not available,
 * exactly as in Paseo's viewer.
 *
 * Uses the budgeted highlighter: it yields to the event loop between steps and
 * returns null past HIGHLIGHT_MAX_SOURCE_BYTES, in which case the file stays plain.
 */
import { highlightCodeWithBudget, isLanguageSupported, type HighlightToken } from "@getpaseo/highlight";
import type { FileDiff } from "../shared/git";

type Runs = [number, string | null][];
export const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

export async function addSyntaxTokens(files: FileDiff[]): Promise<void> {
  for (const file of files) {
    if (!file.lines?.length || file.binary || !isLanguageSupported(file.path)) continue;
    const oldCode: string[] = [];
    const newCode: string[] = [];
    const positions = file.lines.map((line) => {
      const sign = line[0];
      const code = line.slice(1);
      if (sign === " ") { oldCode.push(code); newCode.push(code); return { side: "new" as const, index: newCode.length - 1 }; }
      if (sign === "-") { oldCode.push(code); return { side: "old" as const, index: oldCode.length - 1 }; }
      if (sign === "+") { newCode.push(code); return { side: "new" as const, index: newCode.length - 1 }; }
      return null; // @@ hunk header, "\ No newline"
    });
    const [oldTokens, newTokens] = await Promise.all([
      oldCode.length ? highlightCodeWithBudget(oldCode.join("\n"), file.oldPath ?? file.path, { yieldToEventLoop }) : null,
      newCode.length ? highlightCodeWithBudget(newCode.join("\n"), file.path, { yieldToEventLoop }) : null,
    ]);
    if (!oldTokens && !newTokens) continue;
    file.tokens = positions.map((position, index) => {
      if (!position) return null;
      const tokens = (position.side === "old" ? oldTokens : newTokens)?.[position.index];
      const code = file.lines?.[index]?.slice(1) ?? "";
      return tokens ? toRuns(tokens, code) : null;
    });
  }
}

/** Compact runs; null (plain) if the tokens do not exactly cover the line. */
export function toRuns(tokens: HighlightToken[], code: string): Runs | null {
  const runs: Runs = [];
  let length = 0;
  for (const token of tokens) {
    if (!token.text) continue;
    const last = runs[runs.length - 1];
    if (last && last[1] === token.style) last[0] += token.text.length;
    else runs.push([token.text.length, token.style]);
    length += token.text.length;
  }
  return length === code.length ? runs : null;
}
