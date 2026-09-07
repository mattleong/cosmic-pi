import { diffLines } from "diff";

export function createSimpleDiff(before: string, after: string): string {
  const changes = diffLines(before, after);
  const lastChangeIndex = changes.findLastIndex((change) => change.added || change.removed);
  if (lastChangeIndex < 0) return "";

  const lines: string[] = [];
  let oldLine = 1;
  let newLine = 1;
  const context = 3;
  let firstChangeLine: number | undefined;

  for (const [index, change] of changes.entries()) {
    const chunkLines = splitDiffLines(change.value);

    if (!change.added && !change.removed) {
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
    for (const line of chunkLines) {
      if (change.removed) lines.push(`-${oldLine++} ${line}`);
      else if (change.added) lines.push(`+${newLine++} ${line}`);
    }
  }

  return lines.length ? `@@ ${firstChangeLine} @@\n${lines.join("\n")}` : "";
}

function splitDiffLines(value: string): string[] {
  const lines = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function contextLines(lines: string[], firstLine: number): string[] {
  return lines.map((content, offset) => ` ${firstLine + offset} ${content}`);
}
