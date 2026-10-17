import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  deferredPromise,
  extensionContextFixture,
  recordingExtensionHost,
  settle,
} from "pi-cosmic-core/testing";
import { describe, expect, vi } from "vitest";
import { registerHerdrBtwCommands } from "../src/btw/controller.ts";
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
  let generation = 0;
  registerHerdrBtwCommands(pi, {
    open,
    openNew,
    captureAuthority: () => {
      const captured = generation;
      return () => generation === captured;
    },
  });
  const invoke = (args: string, mode: ExtensionCommandContext["mode"] = "tui") =>
    commands
      .get("herdr-btw")!
      .handler(
        args,
        extensionContextFixture({ mode, hasUI: true, cwd: "/project", ui: { notify } }),
      );
  return { invoke, notify, commands, replaceSession: () => void generation++ };
};

describe("herdr-btw command controller", () => {
  it.effect("does not publish a successful command after its session is replaced", () =>
    Effect.gen(function* () {
      const pending = deferredPromise<HerdrBtwResult>();
      const h = harness(
        () => pending.promise,
        () => pending.promise,
      );
      const command = h.invoke("");
      h.replaceSession();
      pending.resolve(result);
      yield* settle(() => command);
      expect(h.notify).not.toHaveBeenCalled();
    }),
  );
});
