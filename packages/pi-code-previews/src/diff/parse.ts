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
  const numbered = line.match(/^([+\- ])(\s*\d+)\s(.*)$/);
  if (numbered) {
    const [, kind, lineNumber, content] = numbered;
    if (
      (kind !== "+" && kind !== "-" && kind !== " ") ||
      lineNumber === undefined ||
      content === undefined
    )
      return null;
    return { kind, lineNumber, content };
  }

  if (line.startsWith("+++") || line.startsWith("---")) return null;
  // Pi's numbered diffs mark skipped context with a blank number column and "...".
  if (/^ {2,}\.\.\.$/u.test(line)) return null;
  const prefix = line[0];
  if (prefix !== "+" && prefix !== "-" && prefix !== " ") return null;
  return { kind: prefix, lineNumber: "", content: line.slice(1) };
}

export function isAddedDiffLine(line: ParsedDiffLine | null): line is AddedDiffLine {
  return line?.kind === "+";
}

export function isRemovedDiffLine(line: ParsedDiffLine | null): line is RemovedDiffLine {
  return line?.kind === "-";
}

export function isChangedDiffLine(line: ParsedDiffLine): line is AddedDiffLine | RemovedDiffLine {
  return line.kind === "+" || line.kind === "-";
}

export function collectChangedDiffBlock(
  parsedLines: readonly (ParsedDiffLine | null | undefined)[],
  start: number,
) {
  const block: ParsedDiffLine[] = [];
  let end = start;
  while (end < parsedLines.length) {
    const next = parsedLines[end];
    if (!next || !isChangedDiffLine(next)) break;
    block.push(next);
    end++;
  }
  return { block, end };
}
