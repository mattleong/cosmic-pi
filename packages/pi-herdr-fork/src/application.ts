import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { notifyHerdrFork } from "./boundary/host-notifier.ts";
import { captureHerdrForkSession, type HerdrForkSessionInput } from "./boundary/host-session.ts";
import { registerHerdrForkCommand, type HerdrForkCommandOutcome } from "./fork/controller.ts";
import { HerdrForkService, makeHerdrForkService } from "./fork/service.ts";

interface HerdrForkActivation extends HerdrForkSessionInput {
  readonly ctx: ExtensionContext;
}

export const registerHerdrForkApplication = (pi: ExtensionAPI): void => {
  const slot = makePiSessionRuntimeSlot<HerdrForkActivation, HerdrForkService, never, never>({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, Layer.succeed(HerdrForkService, makeHerdrForkService(activation)), {
        agentDirectory: getAgentDir,
        packageName: "pi-herdr-fork",
      }),
    startup: () => Effect.void,
    onStartFailure: ({ ctx }) =>
      notifyHerdrFork(ctx, "The /herdr-fork command failed to initialize.", "error"),
  });

  registerHerdrForkCommand(pi, (prompt) =>
    slot.run(
      HerdrForkService.use((service) => service.open(prompt)).pipe(
        Effect.match({
          onSuccess: (result): HerdrForkCommandOutcome => ({ _tag: "opened", result }),
          onFailure: (failure): HerdrForkCommandOutcome => ({
            _tag: "failed",
            message: failure.message,
          }),
        }),
      ),
    ),
  );

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrForkSession(ctx);
    if (!captured || captured.aborted) {
      notifyHerdrFork(ctx, "The /herdr-fork command could not capture this Pi session.", "error");
      return slot.shutdown();
    }
    return slot.start({ ...captured, ctx }, captured.signal).then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
};
