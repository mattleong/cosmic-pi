import assert from "node:assert/strict";
import { test } from "vitest";
import { profileLine, profilePlacement } from "../../support/word-fixtures/profile-lines";
import { matchChangedLines, type ChangedLinePair } from "../../../src/diff/word/line-matching";

test("sparse matching preserves medium-score reorder identity across its cutoff", () => {
  for (const count of [32, 33]) {
    const removedContents = Array.from({ length: count }, (_, position) =>
      profileLine(position, profilePlacement(position, count), "removed"),
    );
    const addedContents = Array.from({ length: count }, (_, position) =>
      profileLine(count - position - 1, profilePlacement(position, count), "added"),
    );

    const pairs = matchChangedLines(removedLines(removedContents), addedLines(addedContents));

    assert.deepEqual(
      pairPositions(pairs),
      Array.from({ length: count }, (_, position) => [position, count - position - 1]),
      `${count}x${count} pair identities`,
    );
  }
});

test("line matching recovers a shifted 33-line block above the full-matrix cutoff", () => {
  const contents = Array.from({ length: 33 }, (_, index) => uniqueLine(index, "old"));
  const addedOrder = [...Array.from({ length: 32 }, (_, index) => index + 1), 0];
  const addedContents = addedOrder.map((index) => uniqueLine(index, "new"));

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

test("line matching recovers an unambiguous medium-confidence crossing pair", () => {
  const pairs = matchChangedLines(
    removedLines(
      ["featureAlpha commonOne commonTwo old red blue", "stableOmega exactOther before"],
      10,
    ),
    addedLines(
      ["stableOmega exactOther after", "featureAlpha commonOne commonTwo new cyan black"],
      30,
    ),
  );

  assert.deepEqual(pairs, [
    { removedIndex: 10, addedIndex: 31, confidence: "medium" },
    { removedIndex: 11, addedIndex: 30, confidence: "high" },
  ]);
});

test("line matching does not recover ambiguous medium-confidence candidates", () => {
  const pairs = matchChangedLines(
    removedLines(["featureAlpha commonOne commonTwo old red blue"], 10),
    addedLines(
      [
        "featureAlpha commonOne commonTwo new cyan black",
        "featureAlpha commonOne commonTwo fresh purple white",
      ],
      30,
    ),
  );

  assert.deepEqual(pairs, []);
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
    pairs.some((pair) => pair.removedIndex === 0),
    false,
  );
  assert.equal(pairs.length, 31);
  assert.deepEqual(
    pairPositions(pairs),
    Array.from({ length: 31 }, (_, index) => [index + 1, index + 2]),
  );
});

test("sparse anchors do not preempt a stronger positional competitor", () => {
  const common = Array.from(
    { length: 30 },
    (_, index) =>
      `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`,
  ).join(" ");
  const extras = Array.from(
    { length: 6 },
    (_, index) => `extra${String.fromCharCode(97 + index)}`,
  ).join(" ");
  const removedContents = [
    `${common} anchorspecial oldonly`,
    ...Array.from({ length: 32 }, (_, index) => `${common} removedfiller${index}`),
  ];
  const addedContents = [
    `${common} replacementonly`,
    ...Array.from({ length: 31 }, (_, index) => `${common} addedfiller${index}`),
    `${common} anchorspecial ${extras}`,
  ];

  const pairs = matchChangedLines(removedLines(removedContents), addedLines(addedContents));

  assert.equal(
    pairs.some((pair) => pair.removedIndex === 0 && pair.addedIndex === 32),
    false,
  );
  assert.equal(pairs.length, 31);
});

function uniqueLine(index: number, value: "new" | "old"): string {
  return `const record${index}Checksum${1000 + index} = transform${index}(${value}${index});`;
}

function changedLines<Kind extends "-" | "+">(kind: Kind, contents: string[], indexOffset = 0) {
  return contents.map((content, position) => ({
    index: indexOffset + position,
    line: { kind, lineNumber: String(position + 1), content },
  }));
}

const removedLines = (contents: string[], indexOffset?: number) =>
  changedLines("-", contents, indexOffset);
const addedLines = (contents: string[], indexOffset?: number) =>
  changedLines("+", contents, indexOffset);

function pairPositions(pairs: ChangedLinePair[]): number[][] {
  return pairs.map((pair) => [pair.removedIndex, pair.addedIndex]);
}
