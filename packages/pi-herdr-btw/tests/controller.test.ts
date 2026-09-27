import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionApiFixture, extensionContextFixture } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwCommands } from "../src/btw/controller.ts";
import { HerdrBtwError } from "../src/btw/errors.ts";
import type { HerdrBtwResult } from "../src/btw/service.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

const result: HerdrBtwResult = {
  agentName: "btw-agent",
  paneId: "w1:p2",
  mode: "created",
};

const harness = (
  open: (prompt?: string) => Promise<HerdrBtwResult>,
  openNew: (prompt?: string) => Promise<HerdrBtwResult>,
) => {
  const commands = new Map<string, RegisteredCommand>();
  const notify = vi.fn();
  const pi = extensionApiFixture({
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
  });
  registerHerdrBtwCommands(pi, { open, openNew });
  const invoke = (name: string, args: string, mode: ExtensionCommandContext["mode"] = "tui") => {
    const command = commands.get(name);
    if (!command) throw new Error(`Missing command ${name}`);
    return command.handler(
      args,
      extensionContextFixture({ mode, hasUI: true, cwd: "/project", ui: { notify } }),
    );
  };
  return { invoke, notify };
};

describe("herdr-btw command controller", () => {
  it.effect("routes each command to its own handler and rejects non-TUI use", () =>
    Effect.gen(function* () {
      const open = vi.fn(() => Promise.resolve(result));
      const openNew = vi.fn(() => Promise.resolve(result));
      const h = harness(open, openNew);

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw", "  review this  ")));
      expect(open).toHaveBeenCalledWith("review this");
      expect(openNew).not.toHaveBeenCalled();
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "info");

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw-new", "  start fresh  ")));
      expect(openNew).toHaveBeenCalledWith("start fresh");
      expect(open).toHaveBeenCalledOnce();

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw", "review", "rpc")));
      expect(open).toHaveBeenCalledOnce();
      expect(openNew).toHaveBeenCalledOnce();
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    }),
  );

  it.effect("reports a typed workflow failure with error severity", () =>
    Effect.gen(function* () {
      const failure = new HerdrBtwError({
        operation: "start side-session Pi",
        code: "herdr_start_side_session_pi_outcome_uncertain",
        message: "Startup outcome is uncertain.",
        outcome: "uncertain",
      });
      const open = vi.fn(() => Promise.resolve(result));
      const openNew = vi.fn(() => Promise.reject(failure));
      const h = harness(open, openNew);

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw-new", "")));

      expect(open).not.toHaveBeenCalled();
      expect(openNew).toHaveBeenCalledWith(undefined);
      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Startup outcome"), "error");
    }),
  );
});
