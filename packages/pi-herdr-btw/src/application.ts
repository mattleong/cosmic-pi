import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { makeHostHerdrBtwLinkStore, type HerdrBtwLinkStore } from "./boundary/host-link-store.ts";
import { notifyHerdrBtw } from "./boundary/host-notifier.ts";
import { captureHerdrBtwSession, type HerdrBtwSessionInput } from "./boundary/host-session.ts";
import { registerHerdrBtwCommands, type HerdrBtwCommandOutcome } from "./btw/controller.ts";
import {
  HerdrBtwService,
  type HerdrBtwResult,
  type HerdrBtwServiceContract,
} from "./btw/service.ts";
import type { HerdrBtwError } from "./btw/errors.ts";
import { makeHerdrBtwLayer } from "./layer.ts";
import { registerHerdrBtwParentReference } from "./parent-link/register.ts";
import type { HerdrBtwParentReference } from "./parent-link/reference.ts";

interface HerdrBtwActivation extends HerdrBtwSessionInput {
  readonly ctx: ExtensionContext;
  readonly linkStore: HerdrBtwLinkStore;
  readonly parentReference?: HerdrBtwParentReference | undefined;
}

export const registerHerdrBtwApplication = (pi: ExtensionAPI): void => {
  const parentReferenceBridge = registerHerdrBtwParentReference(pi);
  const slot = makePiSessionRuntimeSlot<HerdrBtwActivation, HerdrBtwService, never, never>({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, makeHerdrBtwLayer(activation), {
        agentDirectory: getAgentDir,
        packageName: "pi-herdr-btw",
      }),
    startup: () => Effect.void,
    onActivated: ({ parentReference }) => parentReferenceBridge.activate(parentReference),
    onDeactivated: () => parentReferenceBridge.clear(),
    onStartFailure: ({ ctx }) => {
      parentReferenceBridge.clear();
      notifyHerdrBtw(ctx, "The /herdr-btw command failed to initialize.", "error");
    },
  });

  const runCommand = (
    use: (service: HerdrBtwServiceContract) => Effect.Effect<HerdrBtwResult, HerdrBtwError>,
  ): Promise<HerdrBtwCommandOutcome> =>
    slot.run(
      HerdrBtwService.use(use).pipe(
        Effect.match({
          onSuccess: (result): HerdrBtwCommandOutcome => ({ _tag: "opened", result }),
          onFailure: (failure): HerdrBtwCommandOutcome => ({
            _tag: "failed",
            message: failure.message,
          }),
        }),
      ),
    );

  registerHerdrBtwCommands(pi, {
    open: (prompt) => runCommand((service) => service.open(prompt)),
    openNew: (prompt) => runCommand((service) => service.openNew(prompt)),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrBtwSession(ctx);
    if (!captured || captured.aborted) {
      notifyHerdrBtw(ctx, "The /herdr-btw command could not capture this Pi session.", "error");
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ...captured,
          ctx,
          parentReference: parentReferenceBridge.capture(ctx),
          linkStore: makeHostHerdrBtwLinkStore(pi, ctx, {
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
