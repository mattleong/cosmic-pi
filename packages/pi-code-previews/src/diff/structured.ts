import { diffLines } from "diff";

type DiffLine = { readonly text: string; readonly ending: "" | "\n" | "\r\n" };

const ENDING_SYMBOLS = { "": "", "\n": "␊", "\r\n": "␍␊" } as const;

export function createSimpleDiff(before: string, after: string): string {
  const changes = diffLines(before, after);
  const lastChangeIndex = changes.findLastIndex((change) => change.added || change.removed);
  if (lastChangeIndex < 0) return "";

  const lines: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  const context = 3;
  let firstChangeLine: number | undefined;

  for (let index = 0; index < changes.length; index++) {
    const change = changes[index];
    if (!change) continue;
    if (!change.added && !change.removed) {
      const chunkLines = splitDiffLines(change.value).map((line) => line.text);
      if (firstChangeLine === undefined) {
        const start = Math.max(0, chunkLines.length - context);
        lines.push(...contextLines(chunkLines.slice(start), newLine + start));
      } else if (index < lastChangeIndex && chunkLines.length > context * 2) {
        lines.push(
          ...contextLines(chunkLines.slice(0, context), newLine),
          "...",
          ...contextLines(chunkLines.slice(-context), newLine + chunkLines.length - context),
        );
      } else {
        lines.push(
          ...contextLines(
            index < lastChangeIndex ? chunkLines : chunkLines.slice(0, context),
            newLine,
          ),
        );
      }
      oldLine += chunkLines.length;
      newLine += chunkLines.length;
      continue;
    }

    firstChangeLine ??= newLine;
    // One replacement can arrive as adjacent removed and added chunks; pair them line by line.
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    let next: typeof change | undefined = change;
    while (next?.added || next?.removed) {
      (next.removed ? removed : added).push(...splitDiffLines(next.value));
      next = changes[++index];
    }
    index--;
    for (const [offset, line] of removed.entries())
      lines.push(`-${oldLine++} ${displayText(line, added[offset])}`);
    for (const [offset, line] of added.entries())
      lines.push(`+${newLine++} ${displayText(line, removed[offset])}`);
  }

  return lines.length ? `@@ ${firstChangeLine} @@\n${lines.join("\n")}` : "";
}

/** Rows of a diff between two snippets, without a hunk header: their file position is unknown. */
export function createSnippetDiff(before: string, after: string): string {
  const diff = createSimpleDiff(before, after);
  return diff.slice(diff.indexOf("\n") + 1);
}

/** Lines as Pi's read numbers them: only "\n" ends a line, and "\r\n" is one ending. */
function splitDiffLines(value: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let start = 0;
  while (start < value.length) {
    const newline = value.indexOf("\n", start);
    if (newline < 0) {
      lines.push({ text: value.slice(start), ending: "" });
      break;
    }
    const crlf = newline > start && value.charCodeAt(newline - 1) === 13;
    lines.push({
      text: value.slice(start, crlf ? newline - 1 : newline),
      ending: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

/** A pair that differs only in its line ending shows the endings, so the change is visible. */
function displayText(line: DiffLine, counterpart: DiffLine | undefined): string {
  if (counterpart?.text !== line.text || counterpart.ending === line.ending) return line.text;
  return line.text + ENDING_SYMBOLS[line.ending];
}

function contextLines(lines: string[], firstLine: number): string[] {
  return lines.map((content, offset) => ` ${firstLine + offset} ${content}`);
}
