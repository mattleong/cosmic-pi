import { wordEmphasisGoldenCases, type WordEmphasisGoldenCase } from "./emphasis-golden";
import { profileLine, profilePlacement } from "./profile-lines";

export type WordEmphasisAccuracyCase = WordEmphasisGoldenCase;

export const wordEmphasisAccuracyCases: WordEmphasisAccuracyCase[] = [
  ...wordEmphasisGoldenCases,
  largeReorderedBlockCase(33),
  mediumScoreReorderedBlockCase(33),
];

function largeReorderedBlockCase(count: number): WordEmphasisAccuracyCase {
  const removed = Array.from(
    { length: count },
    (_, index) => `-${index + 1} const record${index} = transform(source${index}, oldMode);`,
  );
  const added = Array.from({ length: count }, (_, position) => {
    const index = count - position - 1;
    return `+${position + 1} const record${index} = transform(source${index}, newMode);`;
  });

  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return {
    name: `sparse anchors recover a reordered ${count}x${count} block`,
    diff: [...removed, ...added],
    expectedSpans: [...removed.map(() => ["old"]), ...added.map(() => ["new"])],
    expectedPairs: Array.from(
      { length: count },
      (_, index) => [index, count + (count - index - 1)] as [number, number],
    ),
  };
}

function mediumScoreReorderedBlockCase(count: number): WordEmphasisAccuracyCase {
  const removed = Array.from({ length: count }, (_, position) => {
    const placement = profilePlacement(position, count);
    return `-${position + 1} ${profileLine(position, placement, "removed")}`;
  });
  const added = Array.from({ length: count }, (_, position) => {
    const placement = profilePlacement(position, count);
    return `+${position + 1} ${profileLine(count - position - 1, placement, "added")}`;
  });

  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return {
    name: `medium-score sparse anchors recover a reordered ${count}x${count} block`,
    diff: [...removed, ...added],
    expectedSpans: [
      ...removed.map((_, position) => profileExpectedSpans(position, count, "removed")),
      ...added.map((_, position) => profileExpectedSpans(position, count, "added")),
    ],
    expectedPairs: Array.from(
      { length: count },
      (_, index) => [index, count + (count - index - 1)] as [number, number],
    ),
  };
}

function profileExpectedSpans(
  position: number,
  count: number,
  side: "added" | "removed",
): string[] {
  const spans =
    position * 2 === count - 1
      ? []
      : position * 2 < count - 1
        ? ["cold", "cold"]
        : ["warm", "warm"];
  return side === "removed"
    ? [...spans, "oldRecord", "legacyOptions"]
    : [...spans, "newAccount", "modernSettings, metadata"];
}
