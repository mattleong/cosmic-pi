import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
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
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import {
  backgroundTaskCodeModeSessionId,
  makeBackgroundTaskCodeModeHost,
} from "./boundary/host-code-mode.ts";
import { registerBackgroundTaskActivity } from "./boundary/host-activity.ts";
import { makeProjectionBridge } from "./boundary/host-ui.ts";
import { BackgroundTaskConfigStore, BackgroundTaskSettingsFiles } from "./config/store.ts";
import type { BackgroundTaskConfig } from "./config/schema.ts";
import { BackgroundTaskService } from "./task/service.ts";
import {
  makeBackgroundTaskLayer,
  type BackgroundTaskApplication,
  type BackgroundTaskRuntimeError,
  type BackgroundTaskSessionInput,
} from "./layer.ts";
import { registerTasksCommand } from "./settings/controller.ts";
import { registerBackgroundTaskTool } from "./tools/background-task.ts";

interface BackgroundTaskSessionActivation extends BackgroundTaskSessionInput {
  /** Revoked before disposal can publish late task settlement into the shared UI bridge. */
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
}

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
  /** The settings this session started with; `/tasks settings` changes apply after /reload. */
  let currentConfig: BackgroundTaskConfig | undefined;
  const revokeActivity = () => {
    releaseActivity?.();
    releaseActivity = undefined;
  };

  const slot = makePiSessionRuntimeSlot<
    BackgroundTaskSessionActivation,
    BackgroundTaskApplication,
    never,
    BackgroundTaskRuntimeError,
    {
      readonly config: BackgroundTaskConfig;
      readonly scheduler: CodePreviewSchedulerServiceContract;
    }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeBackgroundTaskLayer(input, (projection) => {
          if (MutableRef.get(input.publicationOwner)) bridge.publish(projection);
        }),
        { agentDirectory: getAgentDir, packageName: "pi-background-task" },
      ),
    startup: (input) =>
      Effect.gen(function* () {
        // The slot has already deactivated any prior runtime, so no tool call can target the
        // prior session while this activation loads trusted code-preview settings. Replacement
        // and shutdown interrupt this best-effort prerequisite without awaiting a hostile loader.
        yield* bestEffortHostBootstrap("pi-background-task.preview-settings", (signal) =>
          boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
        );
        return {
          config: yield* BackgroundTaskConfigStore,
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
      currentConfig = prepared.config;
      bridge.setFooterEnabled(prepared.config.showFooterStatus);
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
    onDeactivated: (input) => {
      MutableRef.set(input.publicationOwner, false);
      currentConfig = undefined;
      revokeActivity();
      codeModeHost.deactivate();
      bridge.clear();
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Background Tasks couldn't start", "warning");
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
            message: "Background Tasks isn't running in this session",
          }),
        );

  registerTasksCommand(pi, bridge, {
    stop: (id) =>
      run(BackgroundTaskService.use((service) => service.stop(id))).then(() => undefined),
    clear: () => run(BackgroundTaskService.use((service) => service.clear)).then(() => undefined),
    config: () => currentConfig,
    read: (location) => run(BackgroundTaskSettingsFiles.use((files) => files.read(location))),
    write: (location, id, value) =>
      run(BackgroundTaskSettingsFiles.use((files) => files.write(location, id, value))),
  });

  const startSession = (ctx: ExtensionContext) => {
    revokeActivity();
    codeModeHost.deactivate();
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || captured.aborted) {
      bridge.clear();
      return slot.shutdown();
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted: isProjectTrusted(ctx),
          publicationOwner: MutableRef.make(true),
        },
        captured.signal,
      )
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => startSession(ctx));
  // Tree navigation keeps the session id but abandons the prior branch's task ownership.
  // Slot replacement joins process cleanup and revokes capabilities before reactivation.
  pi.on("session_tree", (_event, ctx) => startSession(ctx));

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
