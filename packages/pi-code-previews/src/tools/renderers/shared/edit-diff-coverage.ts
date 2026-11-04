import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { createSimpleDiff } from "../../../diff/structured";
import type { EditPreviewOperation } from "../../data/args";

// Diff lines: a `+`, `-`, or space marker, an optionally padded line number, one space, the line.
const DIFF_LINE = /^([+\- ]) *\d+ (.*)$/su;
// Rewrites longer than this keep their content: a diff that shows every line is unlikely and
// computing it eagerly would cost a frame.
const WRITE_COVERAGE_LINES = 80;

const textLines = (text: string): string[] => {
  const lines = Str.split(text, "\n");
  return lines.length > 1 && lines.at(-1) === "" ? lines.slice(0, -1) : lines;
};

/**
 * Whether a diff shows every line of the given old and new texts, so listing those texts again
 * would only repeat it. Hidden context declines.
 */
function diffShowsText(diff: string, before: readonly string[], after: readonly string[]): boolean {
  const shownBefore = new Set<string>();
  const shownAfter = new Set<string>();
  for (const line of Str.split(diff, "\n")) {
    const match = DIFF_LINE.exec(line);
    const marker = match?.[1];
    const text = match?.[2];
    if (marker === undefined || text === undefined) continue;
    if (marker !== "+") shownBefore.add(text);
    if (marker !== "-") shownAfter.add(text);
  }
  const covered = (texts: readonly string[], shown: ReadonlySet<string>) =>
    Arr.every(texts, (text) => Arr.every(textLines(text), (line) => shown.has(line)));
  return covered(before, shownBefore) && covered(after, shownAfter);
}

/** Whether an applied edit's diff shows every requested old and new line. */
export function editDiffShowsOperations(
  diff: string,
  operations: readonly EditPreviewOperation[],
): boolean {
  return (
    operations.length > 0 &&
    diffShowsText(
      diff,
      Arr.map(operations, ({ oldText }) => oldText),
      Arr.map(operations, ({ newText }) => newText),
    )
  );
}

/** Whether a small rewrite's diff shows every line of the written content. */
export function writeDiffShowsContent(previous: string, content: string): boolean {
  if (textLines(content).length > WRITE_COVERAGE_LINES) return false;
  return diffShowsText(createSimpleDiff(previous, content), [], [content]);
}
