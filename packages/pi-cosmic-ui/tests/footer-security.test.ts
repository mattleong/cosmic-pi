import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { materializeFooterHostProjection } from "../src/boundary/host-footer-projection.ts";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { makeSetStatusSafely } from "../src/boundary/host-status.ts";
import {
  combineSurface,
  isTerminalImageLine,
  renderContributionLine,
} from "../src/footer/layout.ts";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterUpsertEvent,
} from "../src/protocol/protocol.ts";
import { extensionContextFixture, footerDataProviderFixture } from "./support/host.ts";

const kittyImage = "\x1b_Ga=T,f=100,q=2,c=2,r=1;QUJD\x1b\\";
const itermImage = "\x1b[2A\x1b]1337;File=inline=1;size=3;width=2;height=auto:QUJD\x07";

describe("footer terminal safety", () => {
  it("rejects non-theme footer colors before rendering", () => {
    const event = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "owner",
      contribution: {
        kind: "text",
        id: "usage",
        region: "details",
        text: "safe",
        color: "not-a-theme-token",
      },
    });

    expect(event).toBeUndefined();
  });

  it("sanitizes protocol text, compact text, and labels", () => {
    const event = normalizeCosmicFooterUpsertEvent({
      version: COSMIC_UI_PROTOCOL_VERSION,
      owner: "owner",
      contribution: {
        kind: "text",
        id: "usage",
        region: "details",
        text: "\x1b[31mUsage:\n  safe\x1b[0m",
        compactText: "\x1b]52;c;Y2xpcA==\x07compact",
        label: "\x1b[2JProvider\tName",
      },
    });

    expect(event?.contribution).toMatchObject({
      text: "Usage: safe",
      compactText: "compact",
      label: "Provider Name",
    });
  });

  it("sanitizes both outgoing and materialized host status text", () => {
    const setStatus = vi.fn();
    const context = extensionContextFixture({ mode: "tui", ui: { setStatus } });
    makeSetStatusSafely("status")(context, "\x1b[31mready\x1b[0m\nnow");
    expect(setStatus).toHaveBeenCalledWith("status", "ready now");

    const callbacks = makeHostCallbackBoundary();
    // SAFETY: These fixtures provide only the host methods materialized by this boundary test.
    const pi = { getThinkingLevel: () => "off" } as ExtensionAPI;
    const footerData = footerDataProviderFixture({
      getExtensionStatuses: () => new Map([["hostile", "\x1b]52;c;Y2xpcA==\x07status\ntext"]]),
      getGitBranch: () => null,
      getAvailableProviderCount: () => 1,
      onBranchChange: () => () => undefined,
    });
    const projection = materializeFooterHostProjection({
      pi,
      ctx: undefined,
      footerData,
      callbacks,
      model: undefined,
    });
    expect(projection.extensionStatuses).toEqual([{ id: "hostile", text: "status text" }]);
  });

  it("publishes sanitized compact status in RPC mode only", () => {
    const setStatus = vi.fn();
    const update = makeSetStatusSafely("status");
    update(
      extensionContextFixture({ mode: "rpc" as const, hasUI: true, ui: { setStatus } }),
      "\x1b[31mready\x1b[0m\nnow",
    );
    expect(setStatus).toHaveBeenCalledWith("status", "ready now");

    setStatus.mockClear();
    update(
      extensionContextFixture({ mode: "json" as const, hasUI: false, ui: { setStatus } }),
      "hidden",
    );
    update(
      extensionContextFixture({ mode: "print" as const, hasUI: false, ui: { setStatus } }),
      "hidden",
    );
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("maps every semantic contribution tone to its theme token", () => {
    const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
    for (const tone of ["normal", "accent", "dim", "success", "warning", "error"] as const) {
      const rendered = renderContributionLine(
        [{ kind: "text", id: `tone.${tone}`, region: "details", text: tone, tone }],
        80,
        theme,
        false,
      );
      expect(rendered).toContain(`<${tone === "normal" ? "text" : tone}>`);
    }
  });

  it("recognizes only complete anchored pi-tui image forms", () => {
    expect(isTerminalImageLine(kittyImage)).toBe(true);
    expect(isTerminalImageLine(itermImage)).toBe(true);
    expect(isTerminalImageLine(`prefix${kittyImage}`)).toBe(false);
    expect(isTerminalImageLine(`${itermImage}suffix`)).toBe(false);
    expect(isTerminalImageLine("text \x1b_Gnot-an-image")).toBe(false);
    expect(isTerminalImageLine("\x1b]1337;File=not-terminated")).toBe(false);
  });

  it.each([kittyImage, itermImage])("rejects cursor-down suffixes on images", (image) => {
    const line = `${image}\x1b[2B`;
    expect(isTerminalImageLine(line)).toBe(false);
    expect(combineSurface([line], [], 120, "inline-left", 20).join("")).not.toContain("\x1b");
  });

  it("replaces an image's leading cursor-up with balanced inline-left movement", () => {
    const rendered = combineSurface([itermImage], ["first", "last"], 120, "inline-left", 20);
    const output = rendered.join("\n");
    expect(output).not.toContain("\x1b[2A");
    expect(output.split("\x1b[1A")).toHaveLength(2);
    expect(output.split("\x1b[1B")).toHaveLength(2);
    expect(rendered.at(-1)?.endsWith("\x1b[1B")).toBe(true);
    expect(output).toContain(itermImage.slice("\x1b[2A".length));
  });

  it("preserves exact images and keeps ordinary surfaces line- and style-safe", () => {
    const styled = "plain \x1b[31mred\nnext\x1b[2J\x1b]52;c;Y2xpcA==\x07 visible";
    const rendered = combineSurface(
      [kittyImage, itermImage, styled, `prefix${kittyImage}suffix`],
      [],
      120,
      "stacked",
      20,
    );

    expect(rendered[0]).toBe(kittyImage);
    expect(rendered[1]).toBe(itermImage);
    expect(rendered[2]).toContain("\x1b[31mred next");
    expect(rendered[2]?.endsWith("\x1b[0m")).toBe(true);
    expect(rendered[2]).not.toContain("\n");
    expect(rendered[2]).not.toContain("\x1b[2J");
    expect(rendered[2]).not.toContain("52;c;");
    expect(rendered[3]).toBe("prefixsuffix");
  });
});
