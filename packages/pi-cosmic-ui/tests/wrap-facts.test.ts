import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { wrapFacts, wrapWords } from "../src/manager/chrome.ts";

describe("wrapFacts", () => {
  it("wraps between whole facts under a hanging indent, leading each new fact's row with ·", () => {
    const lines = wrapFacts("running · 12s · task-0000000012 · /project", 24);

    expect(lines).toEqual(["running · 12s", "  · task-0000000012", "  · /project"]);
  });

  it("hangs an over-wide fact's continuation past its lead, so only a new fact leads with ·", () => {
    const lines = wrapFacts("cosmic-pi #3038 · the-checkout-redesign-review-session · scout", 24);

    expect(lines).toEqual([
      "cosmic-pi #3038",
      "  · the-checkout-",
      "    redesign-review-",
      "    session · scout",
    ]);
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
    expect(Arr.some(lines, Str.startsWith("  → "))).toBe(true);
  });

  it("breaks a path after its directory before it breaks inside a name too wide for a row", () => {
    const name = "openai-image-2026-09-27T10-41-07-123Z-a-much-longer-name.png";
    const lines = wrapFacts(`Saved to .pi/generated-images/${name}`, 40);
    expect(lines[0]).toBe("Saved to .pi/generated-images/");
    expect(Arr.join(Arr.map(lines, Str.trim), "")).toBe(`Saved to .pi/generated-images/${name}`);
  });

  it("starts a wide path on the next row when only a sliver of it fits beside the words before", () => {
    const path = "~/.pi/agent/subagents/reports/session-1/agent-1-1-4f1c.md";
    const lines = wrapFacts(`28,200 of 152,310 characters kept. Report file: ${path}`, 52);

    expect(lines[0]).toBe("28,200 of 152,310 characters kept. Report file:");
    expect(Arr.join(Arr.map(Arr.drop(lines, 1), Str.trim), "")).toBe(path);
  });

  it("fills each row with a name that has no part narrow enough to break after", () => {
    const blob = `{"file.json":"${Fn.pipe("a", Str.repeat(60))}"}`;
    const lines = wrapFacts(`Wrote out/${blob}`, 30);

    expect(Arr.join(Arr.map(lines, Str.trim), "")).toBe(`Wrote out/${blob}`);
    for (const line of Arr.dropRight(lines, 1)) expect(visibleWidth(line)).toBe(30);
  });

  it("leaves no blank rows between wide characters on a row narrower than one", () => {
    expect(wrapWords("日本語", 1, 1)).toEqual(["日", "本", "語"]);
  });
});
