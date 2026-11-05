import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { wrapFacts } from "../src/manager/chrome.ts";

describe("wrapFacts", () => {
  it("wraps between whole facts under a hanging indent", () => {
    const lines = wrapFacts("running · 12s · task-0000000012 · /project", 24);

    expect(lines).toEqual(["running · 12s", "  task-0000000012", "  /project"]);
  });

  it("keeps packing facts onto the last row of a fact broken across lines", () => {
    const lines = wrapFacts("node scripts/seed.js --fixtures=large:task-0000000012 · /project", 48);

    expect(lines).toEqual([
      "node scripts/seed.js",
      "  --fixtures=large:task-0000000012 · /project",
    ]);
  });

  it("breaks an over-wide fact before its arrow and never ends a line with a separator", () => {
    const lines = wrapFacts(
      "done · reviewer-with-a-long-name → openai-codex/gpt-6.1-sol-high · 2m",
      36,
    );

    for (const line of lines) {
      expect(line).not.toMatch(/ [·→]$/u);
      expect(visibleWidth(line)).toBeLessThanOrEqual(36);
    }
    expect(Arr.some(lines, (line) => Str.startsWith("  → ")(line))).toBe(true);
  });
});
