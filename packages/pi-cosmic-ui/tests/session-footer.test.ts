import * as Arr from "effect/Array";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { expect, it } from "vitest";
import { renderSessionFooter, type SessionFooter } from "../src/footer/session-footer.ts";

const session: SessionFooter = {
  model: { provider: "openai-codex", id: "gpt-6-luna" },
  thinking: "high",
  thinkingMark: "⚡",
  cwd: "/project/web",
  totals: { input: 1200, output: 340, cacheRead: 39_000, cacheWrite: 0, cost: 0.0024 },
  contextPercent: 11,
};
const text = (footer: SessionFooter, width: number) =>
  stripAnsi(Arr.join(renderSessionFooter(footer, width, plainTheme), "\n"));

it("says what a session reports, within the width, and nothing it doesn't", () => {
  for (const width of [57, 120]) {
    const lines = renderSessionFooter(session, width, plainTheme);
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
    const shown = stripAnsi(Arr.join(lines, "\n"));
    expect(shown).toContain("gpt-6-luna");
    expect(shown).toContain("⚡high");
    expect(shown).toContain("11%");
    expect(shown).toContain("↑1.2k");
    expect(shown).toContain("web");
  }
  expect(text(session, 120)).toContain("openai-codex / gpt-6-luna");
  // A share without a window has no token counts to show beside it.
  expect(text(session, 120)).not.toMatch(/\d\/0\b/u);

  const silent = text({ ...session, contextPercent: undefined, thinkingMark: undefined }, 120);
  expect(silent).not.toContain("▤");
  expect(silent).not.toContain("⚡");
  expect(renderSessionFooter(session, 0, plainTheme)).toEqual([]);
});
