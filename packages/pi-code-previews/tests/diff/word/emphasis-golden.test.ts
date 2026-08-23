import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "vitest";
import { renderSyntaxHighlightedDiff } from "../../../src/diff/render";
import { codePreviewSettings, setCodePreviewSettings } from "../../../src/config/state";
import { testTheme } from "../../../src/testing/render";
import { renderedWordEmphasisSpans } from "../../../src/testing/rendered-word-emphasis";
import { wordEmphasisGoldenCases } from "../../../src/diff/word/fixtures/emphasis-golden";

let previousCodePreviewSettings = { ...codePreviewSettings };

beforeEach(() => {
  previousCodePreviewSettings = { ...codePreviewSettings };
});

afterEach(() => {
  setCodePreviewSettings(previousCodePreviewSettings);
});

test("word emphasis golden cases match the curated corpus", () => {
  for (const goldenCase of wordEmphasisGoldenCases) {
    setCodePreviewSettings({
      ...codePreviewSettings,
      wordEmphasis: goldenCase.mode ?? "all",
    });
    const rendered = renderSyntaxHighlightedDiff(
      goldenCase.diff.join("\n"),
      undefined,
      testTheme(),
      goldenCase.diff.length,
    ).split("\n");
    assert.equal(
      rendered.length,
      goldenCase.expectedSpans.length,
      `${goldenCase.name}: rendered line count`,
    );
    assert.deepEqual(
      rendered.map(renderedWordEmphasisSpans),
      goldenCase.expectedSpans,
      `${goldenCase.name}: emphasized spans`,
    );
  }
});
