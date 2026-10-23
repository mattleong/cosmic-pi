import assert from "node:assert/strict";
import { test } from "vitest";
import { selectPreviewLines, selectPreviewTextLines } from "../../src/preview/format";
import * as Arr from "effect/Array";

test("streaming text selection matches array selection across split boundaries", () => {
  for (const total of [1, 7, 8, 9, 12, 30]) {
    const lines = Array.from({ length: total }, (_, index) => `line ${index}`);
    const text = Arr.join(lines, "\n");
    for (const limit of [0, 1, 6, 7, 8, 9, 10, total, total + 1]) {
      const fromArray = selectPreviewLines(lines, limit);
      const fromText = selectPreviewTextLines(text, limit);
      assert.deepEqual(fromText, { ...fromArray, total }, `limit ${limit} of ${total} lines`);
    }
  }
});
