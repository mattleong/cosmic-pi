import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { loadCodePreviewSettings } from "pi-code-previews";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
} from "pi-cosmic-core";
import { makeProjectionBridge } from "./boundary/host-ui.ts";
import { BackgroundTaskConfigStore } from "./config/store.ts";
import { BackgroundTaskService } from "./task/service.ts";
import {
  makeBackgroundTaskLayer,
  type BackgroundTaskApplication,
  type BackgroundTaskRuntimeError,
  type BackgroundTaskSessionInput,
} from "./layer.ts";
import { registerTaskManagerCommand } from "./settings/controller.ts";
import { registerBackgroundTaskTool } from "./tools/background-task.ts";

export interface BackgroundTaskApplicationBoundaries {
  readonly loadSettings: (cwd: string, projectTrusted: boolean) => Promise<void>;
}

const LIVE_APPLICATION_BOUNDARIES: BackgroundTaskApplicationBoundaries = {
  loadSettings: (cwd, projectTrusted) =>
    loadCodePreviewSettings(cwd, projectTrusted).then(() => undefined),
};

export function registerBackgroundTaskApplication(
  pi: ExtensionAPI,
  boundaries: BackgroundTaskApplicationBoundaries = LIVE_APPLICATION_BOUNDARIES,
): void {
  const bridge = makeProjectionBridge(pi.events);

  const slot = makePiSessionRuntimeSlot<
    BackgroundTaskSessionInput,
    BackgroundTaskApplication,
    never,
    BackgroundTaskRuntimeError,
    { readonly showFooterStatus: boolean }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeBackgroundTaskLayer(input, {
          publish: bridge.publish,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-background-task" },
      ),
    startup: (input) =>
      Effect.gen(function* () {
        // The slot has already deactivated any prior runtime, so no tool call can target the
        // prior session while this activation loads trusted code-preview settings. Superseded
        // or aborted starts never reach this settings boundary.
        yield* Effect.tryPromise(() =>
          boundaries.loadSettings(input.cwd, input.projectTrusted),
        ).pipe(Effect.ignore);
        const config = yield* BackgroundTaskConfigStore;
        return { showFooterStatus: config.showFooterStatus };
      }),
    onActivated: ({ ctx }, _token, prepared) => {
      // Only the current-generation activation reaches this hook, and settings are already
      // loaded, so the cooperative-shell wrapper captures the fresh shell mode here.
      registerBackgroundTaskTool(pi, { run });
      bridge.setFooterEnabled(prepared.showFooterStatus);
      bridge.setContext(ctx);
    },
    onDeactivated: () => bridge.clear(),
  });

  // Synchronous activation gate: while a replacement start is still loading settings, the
  // slot already holds the unactivated next runtime, so stale callers must fail typed here
  // instead of reaching it through the bare slot runner.
  const run = <A, E>(
    effect: Effect.Effect<A, E, BackgroundTaskApplication>,
    signal?: AbortSignal,
  ) =>
    slot.isActive()
      ? slot.run(effect, signal)
      : Promise.reject(
          new PiSessionRuntimeError({
            operation: "run",
            message: "Pi session runtime is not active.",
          }),
        );

  registerTaskManagerCommand(pi, bridge, {
    stop: (id) =>
      run(BackgroundTaskService.use((service) => service.stop(id))).then(() => undefined),
    clear: () => run(BackgroundTaskService.use((service) => service.clear)).then(() => undefined),
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || captured.aborted) {
      bridge.clear();
      return slot.shutdown();
    }
    return slot
      .start({ ctx, cwd: captured.cwd, projectTrusted: isProjectTrusted(ctx) }, captured.signal)
      .then(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (slot.isActive()) bridge.setContext(ctx);
  });

  pi.on("session_shutdown", () => {
    bridge.clear();
    return slot.shutdown();
  });
}
