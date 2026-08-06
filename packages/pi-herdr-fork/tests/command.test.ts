// Promise-shaped Pi command callbacks are the subject under test.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerHerdrForkCommand } from "../src/settings/controller.ts";

const setup = (mode: ExtensionCommandContext["mode"] = "tui") => {
  let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  const notify = vi.fn();
  const pi = {
    registerCommand: (_name: string, options: { handler: typeof handler }) => {
      handler = options.handler;
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    mode,
    hasUI: true,
    ui: { notify },
  } as unknown as ExtensionCommandContext;
  return {
    ctx,
    notify,
    pi,
    handler: () => {
      if (!handler) throw new Error("command not registered");
      return handler;
    },
  };
};

describe("/herdr-fork command", () => {
  it("passes one raw prompt string to the deterministic command action", async () => {
    const test = setup();
    const open = vi.fn().mockResolvedValue({
      agentName: "fork-session-p2",
      paneId: "w1:p2",
      childSession: "/sessions/child.jsonl",
      direction: "right",
      prompted: true,
    });
    registerHerdrForkCommand(test.pi, { open });

    await test.handler()("  --review this plan  ", test.ctx);

    expect(open).toHaveBeenCalledWith("--review this plan");
    expect(test.notify).toHaveBeenCalledWith(
      "Opened fork-session-p2 in w1:p2. The pane is now user-owned.",
      "info",
    );
  });

  it("does not run outside the interactive TUI", async () => {
    const test = setup("rpc");
    const open = vi.fn();
    registerHerdrForkCommand(test.pi, { open });

    await test.handler()("", test.ctx);

    expect(open).not.toHaveBeenCalled();
    expect(test.notify).toHaveBeenCalledWith(
      "/herdr-fork is available only in Pi's interactive TUI.",
      "error",
    );
  });
});
