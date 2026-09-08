import { describe, expect, it } from "vitest";
import { formatShortReset, formatWindowedUsageLine } from "../src/subscription-format.ts";

const NOW = 1_700_000_000_000;

describe("subscription formatting", () => {
  it("uses a stable numeric local date and lowercase 12-hour clock", () => {
    const rendered = formatShortReset("5h", 5 * 60, undefined, NOW);
    expect(rendered).toMatch(/^5h ↺ 5m - \d{1,2}\/\d{1,2} • \d{1,2}:\d{2}[ap]$/u);
  });

  it("omits reset rows when reset times are disabled", () => {
    const rendered = formatWindowedUsageLine(
      [{ label: "5h", leftPercent: 80, resetInSeconds: 300 }],
      { showResetTimes: false },
      NOW,
      NOW,
    );
    expect(rendered).toContain("5h: 80%");
    expect(rendered).not.toContain("↺");
  });
});
