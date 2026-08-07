import { describe, expect, it } from "vitest";
import { MAX_ERROR_CHARS } from "../src/run/state.ts";
import { foldRunWarnings } from "../src/run/warnings.ts";

describe("run warning slots", () => {
  it("folds one warning within the completion diagnostic bound", () => {
    const warning = foldRunWarnings({ child: "x".repeat(MAX_ERROR_CHARS * 2) });
    expect(warning).toBeDefined();
    expect(warning!.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
  });

  it("preserves both sources within the shared completion diagnostic bound", () => {
    const warning = foldRunWarnings({
      child: `child-${"c".repeat(MAX_ERROR_CHARS)}`,
      system: `system-${"s".repeat(MAX_ERROR_CHARS)}`,
    });
    expect(warning).toContain("System warning: system-");
    expect(warning).toContain("Child warning: child-");
    expect(warning!.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
  });

  it("deduplicates identical child and system warnings", () => {
    expect(foldRunWarnings({ child: "Same warning.", system: "Same warning." })).toBe(
      "Same warning.",
    );
  });
});
