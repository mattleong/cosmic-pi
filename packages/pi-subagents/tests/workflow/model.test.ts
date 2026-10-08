import { describe, expect, it } from "vitest";
import { appendWorkflowLog, appendWorkflowWarning } from "../../src/workflow/model.ts";

describe("workflow run logs", () => {
  it("clips a long log line or warning without splitting a character", () => {
    const entry = { at: 1, level: "warning" as const, message: `${"x".repeat(1_998)}😀 and more` };
    for (const [clipped] of [appendWorkflowLog([], entry), appendWorkflowWarning([], entry)])
      expect(clipped?.message).toBe(`${"x".repeat(1_998)}…`);
  });
});
