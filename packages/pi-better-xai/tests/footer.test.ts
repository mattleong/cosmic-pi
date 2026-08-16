import { isFunctionValue } from "pi-cosmic-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { describe, expect, test, vi } from "vitest";
import type { FooterMode, ResolvedConfig } from "../src/config/index.ts";
import { createFooterController } from "../src/footer/controller.ts";
import { makeProjection } from "../src/usage/index.ts";
import { extensionContextFixture } from "./support/host.ts";

const resolvedConfig = (mode: FooterMode): ResolvedConfig => ({
  configPath: "/agent/extensions/pi-better-xai.json",
  projectConfigPath: "/project/.pi/extensions/pi-better-xai.json",
  globalConfigPath: "/agent/extensions/pi-better-xai.json",
  projectConfigExists: false,
  globalConfigExists: true,
  usage: {
    enabled: true,
    refreshIntervalMs: 60_000,
    showOnlyOnSubscriptionModels: false,
    showResetTimes: true,
  },
  footer: { mode },
});

function harness(initialMode: FooterMode) {
  const state = { mode: initialMode };
  const setFooter = vi.fn();
  const setStatus = vi.fn();
  const ctx = extensionContextFixture({
    mode: "tui",
    hasUI: true,
    ui: { setFooter, setStatus },
  });
  const projection = makeProjection();
  MutableRef.set(projection, {
    ...MutableRef.get(projection),
    config: resolvedConfig(initialMode),
    eligible: true,
    statusLine: "Usage: 7d: 82%",
  });
  const controller = createFooterController({
    config: () => resolvedConfig(state.mode),
    projection,
    hasTerminalUI: () => true,
  });
  return { controller, ctx, projection, setFooter, setStatus, state };
}

describe("xAI footer host boundaries", () => {
  test("retries installation after the host invokes the factory and then throws", () => {
    const h = harness("replace");
    const staleRequestRender = vi.fn();
    let staleFooter: { dispose(): void } | undefined;
    h.setFooter.mockImplementationOnce((factory) => {
      staleFooter = factory(
        { requestRender: staleRequestRender },
        { fg: (_tone: string, text: string) => text },
      );
      throw new Error("host-install-secret");
    });

    expect(() => h.controller.update(h.ctx)).not.toThrow();
    expect(() => h.controller.update(h.ctx)).not.toThrow();
    staleFooter?.dispose();
    expect(() => h.controller.update(h.ctx)).not.toThrow();

    expect(h.setFooter).toHaveBeenCalledTimes(2);
    expect(h.setFooter.mock.calls[1]?.[0]).toBeTypeOf("function");
    expect(staleRequestRender).not.toHaveBeenCalled();
  });

  test("keeps theme rendering and request-render callbacks total", () => {
    const h = harness("replace");
    let factory: Parameters<ExtensionContext["ui"]["setFooter"]>[0] | undefined;
    h.setFooter.mockImplementation((next) => {
      factory = next;
    });
    h.controller.update(h.ctx);
    expect(factory).toBeTypeOf("function");

    const requestRender = vi.fn(() => {
      throw new Error("host-render-secret");
    });
    const tuiFixture = { requestRender };
    // SAFETY: The Better xAI footer factory uses only requestRender from the TUI host.
    const tui = tuiFixture as typeof tuiFixture & Parameters<NonNullable<typeof factory>>[0];
    const themeFixture = {
      fg() {
        throw new Error("host-theme-secret");
      },
    };
    // SAFETY: The Better xAI footer factory uses only fg from the theme host.
    const theme = themeFixture as typeof themeFixture & Parameters<NonNullable<typeof factory>>[1];
    const footer = factory?.(
      tui,
      theme,
      // SAFETY: The Better xAI footer factory does not read footer data.
      {} as never,
    );

    expect(footer?.render(80)).toEqual([]);
    expect(() => h.controller.update(h.ctx)).not.toThrow();
    expect(requestRender).toHaveBeenCalledTimes(1);
    expect(h.setFooter).toHaveBeenCalledTimes(1);
  });

  test("retries status publication after a host failure", () => {
    const h = harness("status");
    h.setStatus.mockImplementationOnce(() => {
      throw new Error("host-status-secret");
    });

    expect(() => h.controller.update(h.ctx)).not.toThrow();
    expect(() => h.controller.update(h.ctx)).not.toThrow();

    expect(h.setStatus).toHaveBeenCalledTimes(2);
    expect(h.setStatus).toHaveBeenLastCalledWith("better-xai", "Usage: 7d: 82%");
  });

  test("retries footer removal after a host failure", () => {
    const h = harness("replace");
    let failRemoval = true;
    h.setFooter.mockImplementation((next) => {
      if (next === undefined && failRemoval) {
        failRemoval = false;
        throw new Error("host-remove-secret");
      }
    });
    h.controller.update(h.ctx);
    h.state.mode = "off";

    expect(() => h.controller.update(h.ctx)).not.toThrow();
    expect(() => h.controller.update(h.ctx)).not.toThrow();

    expect(h.setFooter).toHaveBeenCalledTimes(3);
    expect(h.setFooter.mock.calls[1]?.[0]).toBeUndefined();
    expect(h.setFooter.mock.calls[2]?.[0]).toBeUndefined();
  });

  test("preserves a footer installed reentrantly while removing the previous generation", () => {
    const h = harness("replace");
    const replacementRender = vi.fn();
    let originalFooter: { dispose(): void } | undefined;
    h.setFooter.mockImplementation((next) => {
      if (isFunctionValue(next)) {
        const footer = next(
          { requestRender: originalFooter ? replacementRender : vi.fn() },
          { fg: (_tone: string, text: string) => text },
        );
        originalFooter ??= footer;
        return;
      }
      originalFooter?.dispose();
      h.state.mode = "replace";
      h.controller.update(h.ctx);
    });

    h.controller.update(h.ctx);
    h.state.mode = "status";
    h.controller.update(h.ctx);
    h.controller.update(h.ctx);

    expect(h.setFooter).toHaveBeenCalledTimes(3);
    expect(h.setFooter.mock.calls[1]?.[0]).toBeUndefined();
    expect(h.setFooter.mock.calls[2]?.[0]).toBeTypeOf("function");
    expect(replacementRender).toHaveBeenCalledTimes(1);
  });

  test("contains hostile terminal-UI getters and retries the full update", () => {
    const h = harness("replace");
    let hostile = true;
    const ctx = extensionContextFixture({
      get mode() {
        if (hostile) throw new Error("host-mode-secret");
        return "tui";
      },
      get hasUI() {
        if (hostile) throw new Error("host-ui-secret");
        return true;
      },
      ui: { setFooter: h.setFooter, setStatus: h.setStatus },
    });
    const controller = createFooterController({
      config: () => resolvedConfig("replace"),
      projection: h.projection,
      hasTerminalUI: (context) =>
        context.mode === "tui" || (context.mode === undefined && context.hasUI),
    });

    expect(() => controller.update(ctx)).not.toThrow();
    expect(h.setFooter).not.toHaveBeenCalled();

    hostile = false;
    expect(() => controller.update(ctx)).not.toThrow();
    expect(h.setFooter).toHaveBeenCalledTimes(1);
  });
});
