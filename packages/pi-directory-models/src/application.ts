/** Per-directory model preferences implemented as an Effect-managed Pi session runtime. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { captureExplicitModelArgument } from "./boundary/host-cli.ts";
import {
  captureContextModel,
  captureSelectedModel,
  captureThinkingLevel,
} from "./boundary/host-model.ts";
import { notifyDirectoryModelWarning } from "./boundary/host-notifier.ts";
import { captureDirectorySession } from "./boundary/host-session.ts";
import {
  makeDirectoryModelsLayer,
  type DirectoryModelsApplication,
  type DirectoryModelsRuntimeError,
} from "./layer.ts";
import {
  DirectoryModelPreferenceService,
  INITIAL_RESTORE_EVENT_STATE,
  type DirectoryModelSessionInput,
} from "./preference/service.ts";

export interface DirectoryModelsApplicationDependencies {
  readonly hasExplicitModel: () => boolean;
}

const defaultDependencies: DirectoryModelsApplicationDependencies = {
  hasExplicitModel: captureExplicitModelArgument,
};

export function registerDirectoryModelsApplication(pi: ExtensionAPI): void {
  registerDirectoryModelsWithDependencies(pi, defaultDependencies);
}

/** Internal seam for deterministic startup-precedence tests. */
export function registerDirectoryModelsWithDependencies(
  pi: ExtensionAPI,
  dependencies: DirectoryModelsApplicationDependencies,
): void {
  const restoreEvents = MutableRef.make(INITIAL_RESTORE_EVENT_STATE);
  const warn = (ctx: ExtensionContext, message: string) =>
    notifyDirectoryModelWarning(ctx, message);

  const slot = makePiSessionRuntimeSlot<
    DirectoryModelSessionInput,
    DirectoryModelsApplication,
    never,
    DirectoryModelsRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeDirectoryModelsLayer(input, {
          restoreEvents,
          warn: (message) => warn(input.ctx, message),
        }),
        { agentDirectory: getAgentDir, packageName: "pi-directory-models" },
      ),
    startup: () => DirectoryModelPreferenceService.use((service) => service.initialize),
    onDeactivated: () => {
      // A non-cancelable setModel settlement may still be completing while runtime disposal waits.
      // Keep its restoration marker active so the host event cannot be mistaken for a user change;
      // the scoped restoration finalizer clears it when settlement finishes.
      if (!MutableRef.get(restoreEvents).active)
        MutableRef.set(restoreEvents, INITIAL_RESTORE_EVENT_STATE);
    },
    onStartFailure: ({ ctx }) => {
      warn(ctx, "Directory model preferences failed to start.");
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, DirectoryModelsApplication>) => slot.run(effect);

  pi.on("session_start", (event, ctx) => {
    const captured = captureDirectorySession(event, ctx);
    if (!captured) {
      warn(ctx, "Directory model preferences are unavailable for this session.");
      return slot.shutdown().then(() => undefined);
    }
    let explicitModel = false;
    try {
      explicitModel = dependencies.hasExplicitModel();
    } catch {
      // Host CLI inspection is best effort; ordinary directory preference behavior remains safe.
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          fresh: captured.fresh,
          explicitModel,
        },
        captured.signal,
      )
      .then(() => undefined);
  });

  pi.on("model_select", (event, ctx) => {
    if (MutableRef.get(restoreEvents).active || event.source === "restore") return;
    const selected = captureSelectedModel(event.model);
    if (!selected) return;
    return run(
      DirectoryModelPreferenceService.use((service) => service.rememberModel(selected)),
    ).catch(() => warn(ctx, "Unable to save the directory model preference."));
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const level = captureThinkingLevel(event.level);
    if (!level) return;
    const restore = MutableRef.get(restoreEvents);
    if (restore.active) {
      MutableRef.set(restoreEvents, {
        ...restore,
        observedThinkingEvents: restore.observedThinkingEvents + 1,
      });
      return;
    }
    if (restore.pendingThinkingEvents > 0) {
      MutableRef.set(restoreEvents, {
        ...restore,
        pendingThinkingEvents: restore.pendingThinkingEvents - 1,
      });
      return;
    }
    const selected = captureContextModel(ctx);
    if (!selected) return;
    // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
    return run(
      DirectoryModelPreferenceService.use((service) => service.rememberThinking(selected, level)),
    ).catch(() => warn(ctx, "Unable to save the directory thinking preference."));
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
