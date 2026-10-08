import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { extensionContextFixture, recordingExtensionHost, settle } from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwCommands } from "../src/btw/controller.ts";
import { HerdrBtwError } from "../src/btw/errors.ts";
import type { HerdrBtwResult } from "../src/btw/service.ts";

const result: HerdrBtwResult = {
  agentName: "btw-agent",
  paneId: "w1:p2",
  mode: "created",
};

const harness = (
  open: (prompt?: string) => Promise<HerdrBtwResult>,
  openNew: (prompt?: string) => Promise<HerdrBtwResult>,
) => {
  const { pi, commands } = recordingExtensionHost();
  const notify = vi.fn();
  registerHerdrBtwCommands(pi, { open, openNew });
  const invoke = (args: string, mode: ExtensionCommandContext["mode"] = "tui") =>
    commands
      .get("herdr-btw")!
      .handler(
        args,
        extensionContextFixture({ mode, hasUI: true, cwd: "/project", ui: { notify } }),
      );
  return { invoke, notify, commands };
};

describe("herdr-btw command controller", () => {
  it.effect(
    "routes a prompt and the new subcommand to their handlers and rejects non-TUI use",
    () =>
      Effect.gen(function* () {
        const open = vi.fn(() => Promise.resolve(result));
        const openNew = vi.fn(() => Promise.resolve(result));
        const h = harness(open, openNew);

        expect([...h.commands.keys()]).toEqual(["herdr-btw"]);
        yield* settle(() => h.invoke("  review this  "));
        expect(open).toHaveBeenCalledWith("review this");
        expect(openNew).not.toHaveBeenCalled();
        expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "info");

        yield* settle(() => h.invoke("new  start fresh  "));
        expect(openNew).toHaveBeenCalledWith("start fresh");
        expect(open).toHaveBeenCalledOnce();

        // Only the exact word starts a fresh session; other prompts go to the linked one.
        yield* settle(() => h.invoke("newer ideas"));
        expect(open).toHaveBeenLastCalledWith("newer ideas");
        expect(openNew).toHaveBeenCalledOnce();

        yield* settle(() => h.invoke("review", "rpc"));
        expect(open).toHaveBeenCalledTimes(2);
        expect(openNew).toHaveBeenCalledOnce();
        expect(h.notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
      }),
  );

  it.effect("reports typed workflow failures but never internal runtime rejection text", () =>
    Effect.gen(function* () {
      const failure = new HerdrBtwError({
        operation: "start side-session Pi",
        code: "herdr_start_side_session_pi_outcome_uncertain",
        message: "Startup outcome is uncertain.",
        outcome: "uncertain",
      });
      const open = vi.fn(() => Promise.reject(new Error("Pi session runtime is not active.")));
      const openNew = vi.fn(() => Promise.reject(failure));
      const h = harness(open, openNew);

      yield* settle(() => h.invoke("new"));

      expect(open).not.toHaveBeenCalled();
      expect(openNew).toHaveBeenCalledWith(undefined);
      expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Startup outcome"), "error");

      yield* settle(() => h.invoke(""));
      expect(h.notify).toHaveBeenLastCalledWith(expect.not.stringContaining("runtime"), "error");
    }),
  );
});
