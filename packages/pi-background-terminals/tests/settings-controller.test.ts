import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeProjectionBridge } from "../src/boundary/host-ui.ts";
import { registerProcessManagerCommand } from "../src/settings/controller.ts";

describe("/ps command", () => {
  it("reports the TUI requirement in RPC mode", () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI;
    const notify = vi.fn();
    registerProcessManagerCommand(pi, makeProjectionBridge(), {
      stop: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    });
    const context = {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext;
    return Promise.resolve(handler?.("", context)).then(() => {
      expect(notify).toHaveBeenCalledWith("/ps requires interactive TUI mode.", "warning");
    });
  });

  it("opens as a terminal-sized overlay", () => {
    let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      registerCommand: (
        _name: string,
        command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
      ) => {
        handler = command.handler;
      },
    } as unknown as ExtensionAPI;
    const custom = vi.fn().mockResolvedValue(undefined);
    registerProcessManagerCommand(pi, makeProjectionBridge(), {
      stop: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    });

    return Promise.resolve(
      handler?.("", {
        mode: "tui",
        hasUI: true,
        ui: { custom },
      } as unknown as ExtensionCommandContext),
    ).then(() => {
      expect(custom).toHaveBeenCalledOnce();
      expect(custom.mock.calls[0]?.[1]).toEqual({
        overlay: true,
        overlayOptions: {
          anchor: "top-left",
          width: "100%",
          maxHeight: "100%",
        },
      });
    });
  });
});
