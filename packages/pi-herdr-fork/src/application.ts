import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { notifyHerdrFork } from "./boundary/host-notifier.ts";
import { captureHerdrForkSession, type HerdrForkSessionInput } from "./boundary/host-session.ts";
import { HerdrForkService } from "./fork/service.ts";
import {
  makeHerdrForkLayer,
  type HerdrForkApplication,
  type HerdrForkRuntimeError,
} from "./layer.ts";
import { registerHerdrForkCommand } from "./settings/controller.ts";

interface HerdrForkActivation extends HerdrForkSessionInput {
  readonly ctx: ExtensionContext;
}

export const registerHerdrForkApplication = (pi: ExtensionAPI): void => {
  const slot = makePiSessionRuntimeSlot<
    HerdrForkActivation,
    HerdrForkApplication,
    never,
    HerdrForkRuntimeError
  >({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, makeHerdrForkLayer(activation), {
        agentDirectory: getAgentDir,
        packageName: "pi-herdr-fork",
      }),
    startup: () => Effect.void,
    onStartFailure: ({ ctx }) =>
      notifyHerdrFork(ctx, "The /herdr-fork command failed to initialize.", "error"),
  });

  registerHerdrForkCommand(pi, {
    open: (prompt) => slot.run(HerdrForkService.use((service) => service.open(prompt))),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrForkSession(ctx);
    if (!captured) {
      notifyHerdrFork(ctx, "The /herdr-fork command could not capture this Pi session.", "error");
      return slot.shutdown().then(() => undefined);
    }
    return slot.start({ ...captured, ctx }, ctx.signal).then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
};
