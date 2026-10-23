import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import { notifyHerdrBtw } from "./boundary/host-notifier.ts";
import { registerHerdrBtwParentReference } from "./boundary/host-parent-reference.ts";
import { captureHerdrBtwSession } from "./boundary/host-session.ts";
import { registerHerdrBtwCommands } from "./btw/controller.ts";
import type { HerdrBtwService } from "./btw/service.ts";
import { isHerdrEnvironment } from "./btw/admission.ts";
import type { HerdrBtwLayerInput } from "./layer.ts";
import type { HerdrBtwParentReference } from "./parent-link/policy.ts";

interface HerdrBtwActivation extends HerdrBtwLayerInput {
  readonly parentReference?: HerdrBtwParentReference | undefined;
}

const loadWorkflow = () => Promise.all([import("./layer.ts"), import("./btw/service.ts")]);

export const registerHerdrBtwApplication = (
  pi: ExtensionAPI,
  load: typeof loadWorkflow = loadWorkflow,
): void => {
  // The session slot owns the import waiter, so retirement also revokes a pending load.
  const workflow = Effect.tryPromise(load).pipe(Effect.orDie);
  const parentReferenceBridge = registerHerdrBtwParentReference(pi);
  const slot = makePiSessionRuntimeSlot<HerdrBtwActivation, HerdrBtwService, never, never>({
    makeRuntime: (activation) =>
      makePiManagedRuntime(
        pi,
        Layer.unwrap(
          workflow.pipe(Effect.map(([{ herdrBtwLayer }]) => herdrBtwLayer(pi, activation))),
        ),
        { agentDirectory: getAgentDir, packageName: "pi-herdr-btw" },
      ),
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
    insideHerdr: () => isHerdrEnvironment(process.env),
    open: (prompt) =>
      slot.run(
        workflow.pipe(
          Effect.flatMap(([, { HerdrBtwService }]) =>
            HerdrBtwService.use((service) => service.open(prompt)),
          ),
        ),
      ),
    openNew: (prompt) =>
      slot.run(
        workflow.pipe(
          Effect.flatMap(([, { HerdrBtwService }]) =>
            HerdrBtwService.use((service) => service.openNew(prompt)),
          ),
        ),
      ),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureHerdrBtwSession(ctx);
    if (!captured || captured.aborted) {
      notifyHerdrBtw(ctx, "Herdr BTW couldn't attach to this Pi session", "warning");
      return slot.shutdown();
    }
    // Commands and side sessions only run inside Herdr panes, so other sessions need no runtime.
    if (!isHerdrEnvironment(captured.environment)) return slot.shutdown();
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
