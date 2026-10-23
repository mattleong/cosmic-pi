export const DIFF_ADD_MARKER = "\u0000PI_DIFF_ADD\u0000";
export const DIFF_REMOVE_MARKER = "\u0000PI_DIFF_REMOVE\u0000";

type DiffLine<Kind extends "+" | "-" | " "> = { kind: Kind; lineNumber: string; content: string };
export type AddedDiffLine = DiffLine<"+">;
export type RemovedDiffLine = DiffLine<"-">;
export type ParsedDiffLine = AddedDiffLine | RemovedDiffLine | DiffLine<" ">;

export function diffLineNumberWidth(lines: Array<ParsedDiffLine | null>): number {
  return lines.reduce((width, line) => Math.max(width, line?.lineNumber.trim().length ?? 0), 0);
}

export function formatDiffLineNumber(lineNumber: string, width: number): string {
  return width > 0 ? lineNumber.trim().padStart(width, " ") : "";
}

export function parseDiffLine(line: string): ParsedDiffLine | null {
  if (line.startsWith("+++") || line.startsWith("---")) return null;
  if (/^ {2,}\.\.\.$/u.test(line)) return null;
  const kind = line[0];
  if (kind !== "+" && kind !== "-" && kind !== " ") return null;
  const [, lineNumber = "", content = line.slice(1)] = /^.(\s*\d+)\s(.*)$/su.exec(line) ?? [];
  return { kind, lineNumber, content };
}

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

export const changedDiffBlocks = (lines: readonly (ParsedDiffLine | null)[]) =>
  diffLineRuns(lines, (line) => (line.kind === " " ? undefined : "changed"));
