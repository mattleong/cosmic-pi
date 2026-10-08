import { expect, it } from "@effect/vitest";
import { formatWindowedUsageLine } from "../src/subscription-format.ts";

const NOW = 1_700_000_000_000;

it("adds reset times to a usage window only when they are enabled", () => {
  const windows = [{ label: "5h", leftPercent: 80, resetInSeconds: 300 }];
  const hidden = formatWindowedUsageLine(windows, { showResetTimes: false }, NOW, NOW);
  const shown = formatWindowedUsageLine(windows, { showResetTimes: true }, NOW, NOW);
  expect(hidden).toContain("5h: 80%");
  expect(shown.length).toBeGreaterThan(hidden.length);
});
