import assert from "node:assert/strict";
import { test } from "vitest";
import { matchChangedLines, type ChangedLinePair } from "../../../src/diff/word/line-matching";
import * as Arr from "effect/Array";

test("line matching recovers a shifted 33-line block above the full-matrix cutoff", () => {
  const contents = Array.from({ length: 33 }, (_, index) => uniqueLine(index, "old"));
  const addedOrder = [...Array.from({ length: 32 }, (_, index) => index + 1), 0];
  const addedContents = Arr.map(addedOrder, (index) => uniqueLine(index, "new"));

  const pairs = matchChangedLines(removedLines(contents), addedLines(addedContents));

  assert.equal(pairs.length, 33);
  assert.deepEqual(
    pairPositions(pairs),
    Array.from({ length: 33 }, (_, removedPosition) => [
      removedPosition,
      removedPosition === 0 ? 32 : removedPosition - 1,
    ]),
  );
});

test("sparse line anchors preserve ambiguity suppression above the cutoff", () => {
  const removedContents = [
    "targetFeature commonOne commonTwo old red blue",
    ...Array.from({ length: 32 }, (_, index) => uniqueLine(index + 1, "old")),
  ];
  const addedContents = [
    "targetFeature commonOne commonTwo new cyan black",
    "targetFeature commonOne commonTwo fresh purple white",
    ...Array.from({ length: 31 }, (_, index) => uniqueLine(index + 1, "new")),
  ];

  const pairs = matchChangedLines(removedLines(removedContents), addedLines(addedContents));

  assert.equal(
    Arr.some(pairs, (pair) => pair.removedIndex === 0),
    false,
  );
  assert.equal(pairs.length, 31);
  assert.deepEqual(
    pairPositions(pairs),
    Array.from({ length: 31 }, (_, index) => [index + 1, index + 2]),
  );
});

function uniqueLine(index: number, value: "new" | "old"): string {
  return `const record${index}Checksum${1000 + index} = transform${index}(${value}${index});`;
}

function changedLines<Kind extends "-" | "+">(kind: Kind, contents: string[], indexOffset = 0) {
  return Arr.map(contents, (content, position) => ({
    index: indexOffset + position,
    line: { kind, lineNumber: String(position + 1), content },
  }));
}

const removedLines = (contents: string[], indexOffset?: number) =>
  changedLines("-", contents, indexOffset);
const addedLines = (contents: string[], indexOffset?: number) =>
  changedLines("+", contents, indexOffset);

function pairPositions(pairs: ChangedLinePair[]): number[][] {
  return Arr.map(pairs, (pair) => [pair.removedIndex, pair.addedIndex]);
}
