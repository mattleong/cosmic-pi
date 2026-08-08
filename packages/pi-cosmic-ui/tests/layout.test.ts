import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import {
  combineSurface,
  renderContextLine,
  renderContributionLine,
  renderProviderUsageLine,
} from "../src/footer/layout.ts";

const theme = { fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[0m` };

describe("responsive footer layout", () => {
  test("keeps styled contribution lines within every requested width", () => {
    const entries = [
      {
        kind: "text" as const,
        id: "path",
        region: "identity" as const,
        text: "~/a/very/long/project/path",
        priority: 100,
      },
      {
        kind: "text" as const,
        id: "model",
        region: "identity" as const,
        text: "provider/extremely-long-model-name • high",
        compactText: "model",
        align: "right" as const,
        priority: 100,
      },
    ];
    for (const width of [12, 24, 48, 80]) {
      expect(
        visibleWidth(renderContributionLine(entries, width, theme, width < 48)),
      ).toBeLessThanOrEqual(width);
    }
  });

  test("renders responsive context and OpenAI usage progress bars", () => {
    const context = renderContextLine(
      { contextWindow: 100_000, tokens: 72_000, percent: 72 },
      [
        {
          kind: "text",
          id: "session",
          region: "metrics",
          text: "footer-redesign",
        },
      ],
      80,
      theme,
      false,
    );
    const usage = renderProviderUsageLine("OpenAI", "Usage: 5h: 90% | 7d: 51%", 80, theme, false);
    const xaiUsage = renderProviderUsageLine("xAI", "Usage: 7d: 82% | mo: 83%", 80, theme, false);

    expect(visibleWidth(context)).toBeLessThanOrEqual(80);
    expect(context).toContain("Ctx");
    expect(context).toContain("72%");
    expect(context).toContain("footer-redesign");
    expect(visibleWidth(usage)).toBeLessThanOrEqual(80);
    expect(usage).toContain("OpenAI");
    expect(usage).toContain("5h");
    expect(usage).toContain("╸");
    expect(visibleWidth(xaiUsage)).toBeLessThanOrEqual(80);
    expect(xaiUsage).toContain("xAI");
    expect(xaiUsage).toContain("7d");
    expect(xaiUsage).toContain("mo");
    expect(xaiUsage).toContain("╸");
  });

  test("renders thin continuous progress tracks", () => {
    const plainTheme = { fg: (_color: string, text: string) => text };

    expect(
      renderContextLine(
        { contextWindow: 100_000, tokens: 62_000, percent: 62 },
        [],
        80,
        plainTheme,
        false,
      ),
    ).toBe("Ctx     ━━━━━━╸─── 62% used · 62k/100k");
    expect(
      renderProviderUsageLine("OpenAI", "Usage: 5h: 72% | 7d: 31%", 80, plainTheme, false),
    ).toBe("OpenAI  5h ━━━━━━━╸── 72% left | 7d ━━━╸────── 31% left");
    expect(renderProviderUsageLine("xAI", "Usage: 7d: 84% | mo: 53%", 80, plainTheme, false)).toBe(
      "xAI     7d ━━━━━━━━╸─ 84% left | mo ━━━━━╸──── 53% left",
    );
  });

  test("keeps explicit used/left labels fitted and safely truncated in narrow compact footers", () => {
    const plainTheme = { fg: (_color: string, text: string) => text };
    const usage = { contextWindow: 100_000, tokens: 62_000, percent: 62 };

    // Compact tracks (6 cells) with the full "% used" / "% left" semantics at their exact fit.
    expect(renderContextLine(usage, [], 34, plainTheme, true)).toBe(
      "Ctx     ━━━╸── 62% used · 62k/100k",
    );
    expect(renderProviderUsageLine("OpenAI", "Usage: 5h: 72%", 26, plainTheme, true)).toBe(
      "OpenAI  5h ━━━━╸─ 72% left",
    );

    // Below the fit width the semantics truncate from the right without overflowing.
    expect(renderContextLine(usage, [], 28, plainTheme, true)).toBe(
      "Ctx     ━━━╸── 62% used · 62[0m",
    );
    expect(renderProviderUsageLine("OpenAI", "Usage: 5h: 72%", 20, plainTheme, true)).toBe(
      "OpenAI  5h ━━━━╸─ 72[0m",
    );
    for (const width of [10, 14, 18, 22, 26, 30, 34]) {
      expect(
        visibleWidth(renderContextLine(usage, [], width, plainTheme, true)),
      ).toBeLessThanOrEqual(width);
      expect(
        visibleWidth(renderProviderUsageLine("OpenAI", "Usage: 5h: 72%", width, plainTheme, true)),
      ).toBeLessThanOrEqual(width);
    }
  });

  test("colors context consumption green through 50% and orange through 75%", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const thresholdTheme = { fg };

    for (const percent of [76, 75, 51, 50])
      renderContextLine(
        { contextWindow: 100_000, tokens: percent * 1_000, percent },
        [],
        80,
        thresholdTheme,
        false,
      );
    renderProviderUsageLine("OpenAI", "Usage: 5h: 75% | 7d: 25%", 80, thresholdTheme, false);
    renderProviderUsageLine("xAI", "Usage: 7d: 75% | mo: 25%", 80, thresholdTheme, false);

    expect(fg.mock.calls).toContainEqual(["error", " 76% used · 76k/100k"]);
    expect(fg.mock.calls).toContainEqual(["warning", " 75% used · 75k/100k"]);
    expect(fg.mock.calls).toContainEqual(["warning", " 51% used · 51k/100k"]);
    expect(fg.mock.calls).toContainEqual(["success", " 50% used · 50k/100k"]);
    expect(fg.mock.calls).toContainEqual(["success", "5h "]);
    expect(fg.mock.calls).toContainEqual(["success", " 75% left"]);
    expect(fg.mock.calls).toContainEqual(["warning", "7d "]);
    expect(fg.mock.calls).toContainEqual(["warning", " 25% left"]);
    expect(fg.mock.calls).toContainEqual(["warning", "mo "]);
  });

  test("uses a varied named theme palette without dim or white footer colors", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const fullColorTheme = { fg };

    renderContributionLine(
      [
        {
          kind: "text",
          id: "model",
          region: "identity",
          text: "openai-codex / gpt-5.6",
        },
        { kind: "text", id: "effort", region: "identity", text: "medium" },
        { kind: "text", id: "location", region: "identity", text: "~/dev/cosmic-pi" },
        { kind: "text", id: "branch", region: "identity", text: "main" },
        { kind: "text", id: "metrics.input", region: "metrics", text: "↑10k" },
        { kind: "text", id: "metrics.cost", region: "metrics", text: "$1.00" },
        { kind: "text", id: "git.lines", region: "identity", text: "+8L -3L ~2L" },
        { kind: "text", id: "legacy-dim", region: "details", text: "legacy", tone: "dim" },
      ],
      200,
      fullColorTheme,
      false,
    );
    renderContextLine(
      { contextWindow: 100_000, tokens: 20_000, percent: 20 },
      [],
      80,
      fullColorTheme,
      false,
    );
    renderProviderUsageLine("OpenAI", "Usage: 5h: 90% | 7d: 51%", 80, fullColorTheme, false);

    const colors = fg.mock.calls.map(([color]) => color);
    expect(colors).toEqual(
      expect.arrayContaining([
        "accent",
        "mdLink",
        "syntaxType",
        "syntaxVariable",
        "syntaxNumber",
        "syntaxPunctuation",
      ]),
    );
    expect(new Set(colors).size).toBeGreaterThanOrEqual(7);
    expect(fg.mock.calls).toContainEqual(["syntaxType", "openai-codex"]);
    expect(fg.mock.calls).toContainEqual(["syntaxPunctuation", " / "]);
    expect(fg.mock.calls).toContainEqual(["mdLink", "gpt-5.6"]);
    expect(fg.mock.calls).toContainEqual(["mdLink", "Ctx     "]);
    expect(fg.mock.calls).toContainEqual(["mdLink", "OpenAI  "]);
    expect(fg.mock.calls).toContainEqual(["syntaxOperator", "medium"]);
    expect(fg.mock.calls).toContainEqual(["success", "+8L"]);
    expect(fg.mock.calls).toContainEqual(["error", "-3L"]);
    expect(fg.mock.calls).toContainEqual(["syntaxNumber", "~2L"]);
    expect(fg.mock.calls).toContainEqual(["success", "5h "]);
    expect(fg.mock.calls).toContainEqual(["warning", "7d "]);
    expect(colors).not.toContain("dim");
    expect(colors).not.toContain("text");
  });

  test("keeps Git line statistics in one block without bullet separators", () => {
    const line = renderContributionLine(
      [{ kind: "text", id: "git.lines", region: "identity", text: "+8L -3L ~2L" }],
      80,
      { fg: (_color: string, text: string) => text },
      false,
    );

    expect(line).toBe("+8L -3L ~2L");
  });

  test("combines inline media without overflowing text rows", () => {
    const lines = combineSurface(["media"], ["some footer text"], 24, "inline-right", 6);
    expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
  });

  test("balances inline-left terminal image cursor movement", () => {
    const imageLine = "\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B";
    const lines = combineSurface(["", imageLine], ["path", "stats"], 20, "inline-left", 4);
    expect(lines[0]).toBe("      path");
    expect(lines[1]).toMatch(/^ {6}stats/);
    expect(lines[1]).toContain("\x1b[0m\r\x1b[1A\x1b_Ga=p,i=1\x1b\\\x1b[1B");
    expect(lines[1]).not.toContain("\x1b[1A\x1b[1A");
    expect(lines[1]).not.toContain("\x1b[1B\x1b[1B");
  });
});
