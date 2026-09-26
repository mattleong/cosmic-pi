// The labeled corpus evaluation is a Promise-shaped shared testing boundary.
import assert from "node:assert/strict";
import { test } from "vitest";
import { evaluateWordEmphasisAccuracy } from "../../support/word-emphasis-accuracy";
import { wordEmphasisAccuracyCases } from "../../support/word-fixtures/emphasis-accuracy";

test("labeled word-emphasis corpus preserves exact spans and line pairs", () =>
  evaluateWordEmphasisAccuracy().then((report) => {
    assert.equal(report.caseCount, wordEmphasisAccuracyCases.length);
    assert.equal(report.exactSpanCases, report.caseCount, "exact rendered-span cases");
    assert.equal(report.pairs.falsePositive, 0, "incorrect emphasized line pairs");
    assert.equal(report.pairs.falseNegative, 0, "missed emphasized line pairs");
  }));
