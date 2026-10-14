import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { notifyHerdrBtw } from "./boundary/host-notifier.ts";
import { registerHerdrBtwParentReference } from "./boundary/host-parent-reference.ts";
import { captureHerdrBtwSession } from "./boundary/host-session.ts";
import { registerHerdrBtwCommands } from "./btw/controller.ts";
import { HerdrBtwService } from "./btw/service.ts";
import { herdrBtwLayer, type HerdrBtwLayerInput } from "./layer.ts";
import type { HerdrBtwParentReference } from "./parent-link/policy.ts";

interface HerdrBtwActivation extends HerdrBtwLayerInput {
  readonly parentReference?: HerdrBtwParentReference | undefined;
}

export const registerHerdrBtwApplication = (pi: ExtensionAPI): void => {
  const parentReferenceBridge = registerHerdrBtwParentReference(pi);
  const slot = makePiSessionRuntimeSlot<HerdrBtwActivation, HerdrBtwService, never, never>({
    makeRuntime: (activation) =>
      makePiManagedRuntime(pi, herdrBtwLayer(pi, activation), {
        agentDirectory: getAgentDir,
        packageName: "pi-herdr-btw",
      }),
    startup: () => Effect.void,
    onActivated: ({ parentReference }) => parentReferenceBridge.activate(parentReference),
    onDeactivated: () => parentReferenceBridge.activate(undefined),
    onStartFailure: ({ ctx }) => {
      parentReferenceBridge.activate(undefined);
      notifyHerdrBtw(ctx, "Herdr BTW couldn't start", "warning");
    },
  });

  registerHerdrBtwCommands(pi, {
    captureAuthority: slot.captureAuthority,
    open: (prompt) => slot.run(HerdrBtwService.use((service) => service.open(prompt))),
    openNew: (prompt) => slot.run(HerdrBtwService.use((service) => service.openNew(prompt))),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrBtwSession(ctx);
    if (!captured || captured.aborted) {
      notifyHerdrBtw(ctx, "Herdr BTW couldn't attach to this Pi session", "warning");
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ...captured,
          ctx,
          parentReference: parentReferenceBridge.capture(ctx),
          linkOwner: {
            sessionId: captured.sessionId ?? "",
            sessionPath: captured.sessionFile ?? "",
          },
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
};
