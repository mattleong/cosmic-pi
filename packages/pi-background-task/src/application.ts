import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  loadCodePreviewSettings,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
} from "pi-cosmic-core";
import {
  backgroundTaskCodeModeSessionId,
  makeBackgroundTaskCodeModeHost,
} from "./boundary/host-code-mode.ts";
import { registerBackgroundTaskActivity } from "./boundary/host-activity.ts";
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
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
}

export function registerBackgroundTaskApplication(
  pi: ExtensionAPI,
  boundaries: BackgroundTaskApplicationBoundaries = { loadSettings: loadCodePreviewSettings },
): void {
  const bridge = makeProjectionBridge(pi.events);
  const codeModeHost = makeBackgroundTaskCodeModeHost(pi.events);
  let releaseActivity: (() => void) | undefined;
  const revokeActivity = () => {
    releaseActivity?.();
    releaseActivity = undefined;
  };

  const slot = makePiSessionRuntimeSlot<
    BackgroundTaskSessionInput,
    BackgroundTaskApplication,
    never,
    BackgroundTaskRuntimeError,
    { readonly showFooterStatus: boolean; readonly scheduler: CodePreviewSchedulerServiceContract }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(pi, makeBackgroundTaskLayer(input, bridge.publish), {
        agentDirectory: getAgentDir,
        packageName: "pi-background-task",
      }),
    startup: (input) =>
      Effect.gen(function* () {
        // The slot has already deactivated any prior runtime, so no tool call can target the
        // prior session while this activation loads trusted code-preview settings. Replacement
        // and shutdown interrupt this best-effort prerequisite without awaiting a hostile loader.
        yield* bestEffortHostBootstrap("pi-background-task.preview-settings", (signal) =>
          boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
        );
        const config = yield* BackgroundTaskConfigStore;
        return {
          showFooterStatus: config.showFooterStatus,
          scheduler: yield* CodePreviewSchedulerService,
        };
      }),
    onActivated: ({ ctx, cwd }, token, prepared) => {
      // Only the current-generation activation reaches this hook, and settings are already
      // loaded, so the cooperative-shell wrapper captures the fresh shell mode here.
      registerBackgroundTaskTool(pi, {
        run,
        scheduleAnimation: (interval, tick) =>
          slot.isCurrent(token) ? prepared.scheduler.schedule(interval, tick) : undefined,
      });
      codeModeHost.activate({
        sessionId: backgroundTaskCodeModeSessionId(ctx),
        sessionCwd: cwd,
        tokenCurrent: () => slot.isCurrent(token),
        toolActive: () =>
          invokeHostCallback(() => pi.getActiveTools().includes("background_task"), false),
        run,
      });
      bridge.setFooterEnabled(prepared.showFooterStatus);
      bridge.setContext(ctx);
      const sessionId = backgroundTaskCodeModeSessionId(ctx);
      if (sessionId)
        releaseActivity = registerBackgroundTaskActivity({
          events: pi.events,
          sessionId,
          bridge,
          isCurrent: () => slot.isCurrent(token) && slot.isActive(),
          stop: (id, signal) =>
            run(
              BackgroundTaskService.use((service) => service.stop(id)),
              signal,
            ).then(() => undefined),
        });
    },
    onDeactivated: () => {
      revokeActivity();
      codeModeHost.deactivate();
      bridge.clear();
    },
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
    status: () => run(BackgroundTaskConfigStore),
  });

  pi.on("session_start", (_event, ctx) => {
    revokeActivity();
    codeModeHost.deactivate();
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
    revokeActivity();
    codeModeHost.deactivate();
    bridge.clear();
    return slot.shutdown().finally(codeModeHost.dispose);
  });
}
