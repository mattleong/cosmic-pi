/** Private markers used to carry add/remove kind through full-width diff text. */
export const DIFF_ADD_MARKER = "\u0000PI_DIFF_ADD\u0000";
export const DIFF_REMOVE_MARKER = "\u0000PI_DIFF_REMOVE\u0000";

export type ParsedDiffLine = { kind: "+" | "-" | " "; lineNumber: string; content: string };
export type AddedDiffLine = ParsedDiffLine & { kind: "+" };
export type RemovedDiffLine = ParsedDiffLine & { kind: "-" };

export function diffLineNumberWidth(lines: Array<ParsedDiffLine | null>): number {
  return lines.reduce((width, line) => Math.max(width, line?.lineNumber.trim().length ?? 0), 0);
}

/** A zero width omits the number, for diffs whose numbers are not file positions. */
export function formatDiffLineNumber(lineNumber: string, width: number): string {
  return width > 0 ? lineNumber.trim().padStart(width, " ") : "";
}

export function parseDiffLine(line: string): ParsedDiffLine | null {
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  // Pi's numbered diffs mark skipped context with a blank number column and "...".
  if (/^ {2,}\.\.\.$/u.test(line)) return null;
  const kind = line[0];
  if (kind !== "+" && kind !== "-" && kind !== " ") return null;
  // Rows are already split on "\n"; a lone CR, U+2028 or U+2029 is content (dotAll).
  const [, lineNumber = "", content = line.slice(1)] = /^.(\s*\d+)\s(.*)$/su.exec(line) ?? [];
  return { kind, lineNumber, content };
}

export function isAddedDiffLine(line: ParsedDiffLine | null): line is AddedDiffLine {
  return line?.kind === "+";
}

export function isRemovedDiffLine(line: ParsedDiffLine | null): line is RemovedDiffLine {
  return line?.kind === "-";
}

/** Maximal `[start, end)` runs of consecutive parsed lines that share a defined key. */
export function* diffLineRuns(
  lines: readonly (ParsedDiffLine | null)[],
  key: (line: ParsedDiffLine) => string | undefined,
): Generator<readonly [start: number, end: number]> {
  const keyAt = (index: number) => {
    const line = lines[index];
    return line ? key(line) : undefined;
  };
  for (let start = 0, end = 0; start < lines.length; start = end) {
    const runKey = keyAt(start);
    end = start + 1;
    if (runKey === undefined) continue;
    while (end < lines.length && keyAt(end) === runKey) end++;
    yield [start, end];
  }
}

/** Maximal runs of added and removed rows; word emphasis pairs lines only within one run. */
export const changedDiffBlocks = (lines: readonly (ParsedDiffLine | null)[]) =>
  diffLineRuns(lines, (line) => (line.kind === " " ? undefined : "changed"));
