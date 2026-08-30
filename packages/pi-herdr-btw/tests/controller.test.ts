import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwCommands } from "../src/btw/controller.ts";
import { HerdrBtwError } from "../src/btw/errors.ts";
import type { HerdrBtwResult } from "../src/btw/service.ts";

type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

// SAFETY: Each call supplies every host member read by the command controller.
const testDouble = <Value>(value: Partial<Value>): Value => value as Value;

const result: HerdrBtwResult = {
  agentName: "btw-agent",
  paneId: "w1:p2",
  mode: "created",
  prompted: false,
  direction: "right",
};

const harness = (open: (prompt?: string) => Promise<HerdrBtwResult>) => {
  const commands = new Map<string, RegisteredCommand>();
  const notify = vi.fn();
  const pi = testDouble<ExtensionAPI>({
    registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
  });
  registerHerdrBtwCommands(pi, { open, openNew: open });
  const invoke = (name: string, args: string, mode: ExtensionCommandContext["mode"] = "tui") => {
    const command = commands.get(name);
    if (!command) throw new Error(`Missing command ${name}`);
    return command.handler(
      args,
      testDouble<ExtensionCommandContext>({
        mode,
        hasUI: true,
        cwd: "/project",
        ui: testDouble<ExtensionCommandContext["ui"]>({ notify }),
      }),
    );
  };
  return { invoke, notify };
};

describe("herdr-btw command controller", () => {
  it.effect("routes a trimmed prompt in TUI mode and rejects non-TUI use", () =>
    Effect.gen(function* () {
      const open = vi.fn(() => Promise.resolve(result));
      const h = harness(open);

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw", "  review this  ")));
      expect(open).toHaveBeenCalledWith("review this");
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "info");

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw", "review", "rpc")));
      expect(open).toHaveBeenCalledOnce();
      expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "error");
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
      const h = harness(() => Promise.reject(failure));

      yield* Effect.promise(() => Promise.resolve(h.invoke("herdr-btw:new", "")));

      expect(h.notify).toHaveBeenCalledWith(failure.message, "error");
    }),
  );
});
