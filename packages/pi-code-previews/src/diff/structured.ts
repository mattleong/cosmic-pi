import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { codeUnitAt, indexOfFrom } from "pi-cosmic-core/text-scan";
import { diffLines } from "diff";

// Bound once: Pi's loader routes each imported-helper call through an interop proxy.
const codeAt = codeUnitAt;
const indexFrom = indexOfFrom;

type DiffLine = { readonly text: string; readonly ending: "" | "\n" | "\r\n" };

const ENDING_SYMBOLS = { "": "", "\n": "␊", "\r\n": "␍␊" } as const;

const CONTEXT_LINES = 3;

type DiffChanges = ReturnType<typeof diffLines>;

interface DiffCursor {
  oldLine: number;
  newLine: number;
  firstChangeLine: number | undefined;
  readonly lines: string[];
}

export function createSimpleDiff(before: string, after: string): string {
  const changes = diffLines(before, after);
  const lastChange = Arr.findLastIndex(changes, (change) => change.added || change.removed);
  if (Option.isNone(lastChange)) return "";
  const lastChangeIndex = lastChange.value;

  const cursor: DiffCursor = { oldLine: 1, newLine: 1, firstChangeLine: undefined, lines: [] };
  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change) continue;
    if (!change.added && !change.removed) {
      appendUnchanged(cursor, change.value, index < lastChangeIndex);
      continue;
    }
    index = appendChangeRun(cursor, changes, index);
  }

  const { lines, firstChangeLine } = cursor;
  return firstChangeLine !== undefined && lines.length
    ? `@@ ${firstChangeLine} @@\n${Arr.join(lines, "\n")}`
    : "";
}

function unchangedContext(
  chunkLines: string[],
  cursor: DiffCursor,
  beforeLastChange: boolean,
): string[] {
  if (cursor.firstChangeLine === undefined) {
    const start = Math.max(0, chunkLines.length - CONTEXT_LINES);
    return contextLines(chunkLines.slice(start), cursor.newLine + start);
  }
  if (beforeLastChange && chunkLines.length > CONTEXT_LINES * 2)
    return [
      ...contextLines(chunkLines.slice(0, CONTEXT_LINES), cursor.newLine),
      "...",
      ...contextLines(
        chunkLines.slice(-CONTEXT_LINES),
        cursor.newLine + chunkLines.length - CONTEXT_LINES,
      ),
    ];
  return contextLines(
    beforeLastChange ? chunkLines : chunkLines.slice(0, CONTEXT_LINES),
    cursor.newLine,
  );
}

function appendUnchanged(cursor: DiffCursor, value: string, beforeLastChange: boolean): void {
  const chunkLines = Arr.map(splitDiffLines(value), (line) => line.text);
  cursor.lines.push(...unchangedContext(chunkLines, cursor, beforeLastChange));
  cursor.oldLine += chunkLines.length;
  cursor.newLine += chunkLines.length;
}

function appendChangeRun(cursor: DiffCursor, changes: DiffChanges, start: number): number {
  cursor.firstChangeLine ??= cursor.newLine;
  const removed: DiffLine[] = [];
  const added: DiffLine[] = [];
  let index = start;
  let next = changes[index];
  while (next?.added || next?.removed) {
    (next.removed ? removed : added).push(...splitDiffLines(next.value));
    next = changes[++index];
  }
  for (const [offset, line] of removed.entries())
    cursor.lines.push(`-${cursor.oldLine++} ${displayText(line, added[offset])}`);
  for (const [offset, line] of added.entries())
    cursor.lines.push(`+${cursor.newLine++} ${displayText(line, removed[offset])}`);
  return index - 1;
}

export function createSnippetDiff(before: string, after: string): string {
  const diff = createSimpleDiff(before, after);
  return Option.match(Fn.pipe(diff, Str.indexOf("\n")), {
    onNone: () => diff,
    onSome: (newline) => Fn.pipe(diff, Str.slice(newline + 1)),
  });
}

function splitDiffLines(value: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let start = 0;
  while (start < value.length) {
    const newline = indexFrom(value, "\n", start);
    if (newline < 0) {
      lines.push({ text: Fn.pipe(value, Str.slice(start)), ending: "" });
      break;
    }
    const crlf = newline > start && codeAt(value, newline - 1) === 13;
    lines.push({
      text: Fn.pipe(value, Str.slice(start, crlf ? newline - 1 : newline)),
      ending: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

function displayText(line: DiffLine, counterpart: DiffLine | undefined): string {
  if (counterpart?.text !== line.text || counterpart.ending === line.ending) return line.text;
  return line.text + ENDING_SYMBOLS[line.ending];
}

function contextLines(lines: string[], firstLine: number): string[] {
  return Arr.map(lines, (content, offset) => ` ${firstLine + offset} ${content}`);
}
