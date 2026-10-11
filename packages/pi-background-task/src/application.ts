import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Predicate from "effect/Predicate";
import {
  loadCodePreviewSettings,
  registerCodePreviewReplay,
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
import { registerBackgroundTaskActivity } from "./boundary/host-activity.ts";
import { discoverActivityView } from "pi-cosmic-ui/activity/view";
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
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
  readonly publishesReplay: boolean;
}

const UNAVAILABLE = "Background Tasks aren't available in this session";

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
  const replay = registerCodePreviewReplay(pi, { command: "tasks", tools: ["background_task"] });
  let releaseActivity: (() => void) | undefined;
  let openActivity: ((signal?: AbortSignal) => Promise<boolean>) | undefined;
  let currentConfig: BackgroundTaskConfig | undefined;

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
        yield* bestEffortHostBootstrap("pi-background-task.preview-settings", (signal) =>
          boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
        );
        return {
          config: yield* BackgroundTaskConfigStore,
          scheduler: yield* CodePreviewSchedulerService,
        };
      }),
    onActivated: ({ ctx, publishesReplay }, token, prepared) => {
      registerBackgroundTaskTool(
        pi,
        {
          run: runWhen(() => slot.isCurrent(token)),
          scheduleAnimation: (interval, tick) =>
            slot.isCurrent(token) ? prepared.scheduler.schedule(interval, tick) : undefined,
        },
        replay.shell,
      );
      if (publishesReplay) replay.publish();
      const sessionId = invokeHostCallback(() => {
        const id = ctx.sessionManager?.getSessionId?.();
        return Predicate.isString(id) && id.length > 0 ? id : undefined;
      }, undefined);
      currentConfig = prepared.config;
      bridge.setFooterEnabled(prepared.config.showFooterStatus);
      bridge.setContext(ctx);
      openActivity = (signal) => {
        if (!slot.isCurrent(token) || signal?.aborted) throw new Error(UNAVAILABLE);
        const capability = sessionId ? discoverActivityView(pi.events, sessionId) : undefined;
        return Promise.resolve(capability ? capability.open("tasks", signal) : false).then(
          (opened) => {
            if (!slot.isCurrent(token) || signal?.aborted)
              throw new Error("Background Tasks session was replaced");
            return opened;
          },
        );
      };
      if (sessionId)
        releaseActivity = registerBackgroundTaskActivity({
          events: pi.events,
          sessionId,
          bridge,
          isCurrent: () => slot.isCurrent(token),
          stop: stopTask,
          clear: clearTasks,
        });
    },
    onDeactivated: (input) => {
      MutableRef.set(input.publicationOwner, false);
      currentConfig = undefined;
      openActivity = undefined;
      releaseActivity?.();
      releaseActivity = undefined;
      bridge.clear();
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Background Tasks couldn't start", "warning");
    },
  });

  const runWhen =
    (isCurrent: () => boolean) =>
    <A, E>(effect: Effect.Effect<A, E, BackgroundTaskApplication>, signal?: AbortSignal) =>
      isCurrent()
        ? slot.run(effect, signal)
        : Promise.reject(
            new PiSessionRuntimeError({
              operation: "run",
              message: "Background Tasks isn't running in this session",
            }),
          );
  const run = runWhen(() => slot.isActive());
  const stopTask = (id: string, signal?: AbortSignal) =>
    run(
      BackgroundTaskService.use((service) => Effect.asVoid(service.stop(id))),
      signal,
    );
  const clearTasks = (signal?: AbortSignal) =>
    run(
      BackgroundTaskService.use((service) => Effect.asVoid(service.clear)),
      signal,
    );

  registerTasksCommand(pi, bridge, {
    captureAuthority: slot.captureAuthority,
    openActivity: (signal) =>
      openActivity ? openActivity(signal) : Promise.reject(new Error(UNAVAILABLE)),
    stop: (id) => stopTask(id),
    clear: () => clearTasks(),
    config: () => currentConfig,
    read: (location) => run(BackgroundTaskSettingsFiles.use((files) => files.read(location))),
    write: (location, id, value) =>
      run(BackgroundTaskSettingsFiles.use((files) => files.write(location, id, value))),
  });

  const startSession = (ctx: ExtensionContext, publishesReplay: boolean) => {
    const captured = captureSessionHost(ctx);
    if (captured._tag === "Unavailable" || captured.aborted) return slot.shutdown();
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted: isProjectTrusted(ctx),
          publicationOwner: MutableRef.make(true),
          publishesReplay,
        },
        captured.signal,
      )
      .then(() => undefined);
  };

  pi.on("session_start", (_event, ctx) => startSession(ctx, true).finally(replay.finishStartup));
  pi.on("session_tree", (_event, ctx) => startSession(ctx, false));

  pi.on("turn_end", (_event, ctx) => {
    if (slot.isActive()) bridge.setContext(ctx);
  });

  pi.on("session_shutdown", () => {
    replay.retire();
    return slot.shutdown();
  });
}
