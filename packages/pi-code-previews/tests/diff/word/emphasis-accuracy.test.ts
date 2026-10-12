import assert from "node:assert/strict";
import { effectTest, step } from "../../support/effect-test";
import { evaluateWordEmphasisAccuracy } from "../../support/word-emphasis-accuracy";
import { wordEmphasisAccuracyCases } from "../../support/word-fixtures/emphasis-accuracy";

effectTest("labeled word-emphasis corpus preserves exact spans and line pairs", function* () {
  const report = yield* step(() => evaluateWordEmphasisAccuracy());
  assert.equal(report.caseCount, wordEmphasisAccuracyCases.length);
  assert.equal(report.exactSpanCases, report.caseCount, "exact rendered-span cases");
  assert.equal(report.pairs.falsePositive, 0, "incorrect emphasized line pairs");
  assert.equal(report.pairs.falseNegative, 0, "missed emphasized line pairs");
});
