import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { makeHostHerdrForkLinkStore, type HerdrForkLinkStore } from "./boundary/host-link-store.ts";
import { notifyHerdrFork } from "./boundary/host-notifier.ts";
import { captureHerdrForkSession, type HerdrForkSessionInput } from "./boundary/host-session.ts";
import { registerHerdrForkCommands, type HerdrForkCommandOutcome } from "./fork/controller.ts";
import {
  HerdrForkService,
  type HerdrForkResult,
  type HerdrForkServiceContract,
} from "./fork/service.ts";
import type { HerdrForkError } from "./fork/errors.ts";
import { makeHerdrForkLayer } from "./layer.ts";
import { registerHerdrForkParentReference } from "./parent-link/register.ts";
import type { HerdrForkParentReference } from "./parent-link/reference.ts";

interface HerdrForkActivation extends HerdrForkSessionInput {
  readonly ctx: ExtensionContext;
  readonly linkStore: HerdrForkLinkStore;
  readonly parentReference?: HerdrForkParentReference | undefined;
}

export const registerHerdrForkApplication = (pi: ExtensionAPI): void => {
  const parentReferenceBridge = registerHerdrForkParentReference(pi);
  const slot = makePiSessionRuntimeSlot<HerdrForkActivation, HerdrForkService, never, never>({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, makeHerdrForkLayer(activation), {
        agentDirectory: getAgentDir,
        packageName: "pi-herdr-fork",
      }),
    startup: () => Effect.void,
    onActivated: ({ parentReference }) => parentReferenceBridge.activate(parentReference),
    onDeactivated: () => parentReferenceBridge.clear(),
    onStartFailure: ({ ctx }) => {
      parentReferenceBridge.clear();
      notifyHerdrFork(ctx, "The /herdr-fork command failed to initialize.", "error");
    },
  });

  const runCommand = (
    use: (service: HerdrForkServiceContract) => Effect.Effect<HerdrForkResult, HerdrForkError>,
  ): Promise<HerdrForkCommandOutcome> =>
    slot.run(
      HerdrForkService.use(use).pipe(
        Effect.match({
          onSuccess: (result): HerdrForkCommandOutcome => ({ _tag: "opened", result }),
          onFailure: (failure): HerdrForkCommandOutcome => ({
            _tag: "failed",
            message: failure.message,
          }),
        }),
      ),
    );

  registerHerdrForkCommands(pi, {
    open: (prompt) => runCommand((service) => service.open(prompt)),
    openNew: (prompt) => runCommand((service) => service.openNew(prompt)),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrForkSession(ctx);
    if (!captured || captured.aborted) {
      notifyHerdrFork(ctx, "The /herdr-fork command could not capture this Pi session.", "error");
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ...captured,
          ctx,
          parentReference: parentReferenceBridge.capture(ctx),
          linkStore: makeHostHerdrForkLinkStore(pi, ctx, {
            sessionId: captured.sessionId ?? "",
            sessionPath: captured.sessionFile ?? "",
          }),
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
};
