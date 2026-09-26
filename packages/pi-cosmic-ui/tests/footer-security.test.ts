import { describe, expect, it, vi } from "vitest";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { materializeFooterHostProjection } from "../src/boundary/host-footer-projection.ts";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { makeSetStatusSafely } from "../src/boundary/host-status.ts";
import {
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterUpsertEvent,
} from "../src/protocol/protocol.ts";
import { footerDataProviderFixture } from "./support/host.ts";

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

  it("sanitizes materialized host status text", () => {
    const callbacks = makeHostCallbackBoundary();
    const pi = extensionApiFixture({ getThinkingLevel: () => "off" });
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

  it.each([
    ["tui", true],
    ["rpc", true],
    ["json", false],
    ["print", false],
  ] as const)("publishes sanitized status in %s mode: %s", (mode, delivered) => {
    const setStatus = vi.fn();
    const context = extensionContextFixture({ mode, hasUI: delivered, ui: { setStatus } });
    makeSetStatusSafely("status")(context, "\x1b[31mready\x1b[0m\nnow");
    expect(setStatus.mock.calls).toEqual(delivered ? [["status", "ready now"]] : []);
  });
});
