// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { registerSubagentManagerCommand } from "../src/settings/controller.ts";

const actions = {
  stop: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  resume: () => Promise.resolve(),
  send: () => Promise.resolve(),
  reply: () => Promise.resolve(),
  rename: () => Promise.resolve(),
};

describe("/subagents command", () => {
  it("reports the TUI requirement outside interactive mode", async () => {
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
    registerSubagentManagerCommand(pi, makeSubagentProjectionBridge(), actions);

    await handler?.("", {
      mode: "rpc",
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionCommandContext);

    expect(notify).toHaveBeenCalledWith("/subagents requires interactive TUI mode.", "warning");
  });

  it("opens a terminal-sized overlay", async () => {
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
    registerSubagentManagerCommand(pi, makeSubagentProjectionBridge(), actions);

    await handler?.("", {
      mode: "tui",
      hasUI: true,
      ui: { custom },
    } as unknown as ExtensionCommandContext);

    expect(custom.mock.calls[0]?.[1]).toEqual({
      overlay: true,
      overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
    });
  });
});
