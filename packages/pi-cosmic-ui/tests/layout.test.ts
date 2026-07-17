import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { combineSurface, renderContributionLine } from "../src/footer/layout.ts";
import { FooterContributionRegistry } from "../src/footer/registry.ts";

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

describe("contribution registry", () => {
  test("keeps owner and contribution identifiers collision-safe", () => {
    const registry = new FooterContributionRegistry();
    registry.upsert("a", {
      kind: "text",
      id: "b:c",
      region: "details",
      text: "first",
    });
    registry.upsert("a:b", {
      kind: "text",
      id: "c",
      region: "details",
      text: "second",
    });

    expect(
      registry.list().map((entry) => (entry.kind === "text" ? entry.text : "surface")),
    ).toEqual(["first", "second"]);
    registry.remove("a");
    expect(registry.list()).toEqual([expect.objectContaining({ id: "c", text: "second" })]);
  });

  test("attaches, invalidates, and disposes surfaces", () => {
    const registry = new FooterContributionRegistry();
    const requestRender = vi.fn();
    const attach = vi.fn();
    const detach = vi.fn();
    const invalidate = vi.fn();
    const dispose = vi.fn();
    registry.setRenderRequest(requestRender);
    registry.upsert("owner", {
      kind: "surface",
      id: "media",
      region: "media",
      preferredWidth: 8,
      attach,
      detach,
      invalidate,
      dispose,
      render: () => [],
    });
    expect(attach).toHaveBeenCalledOnce();
    registry.setRenderRequest(undefined);
    expect(detach).toHaveBeenCalledOnce();
    registry.invalidate("owner", "media");
    expect(invalidate).toHaveBeenCalledOnce();
    registry.remove("owner");
    expect(dispose).toHaveBeenCalledOnce();
  });
});
