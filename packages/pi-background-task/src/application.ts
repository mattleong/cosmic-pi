import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
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
import { bestEffortHostBootstrap } from "pi-cosmic-core/runtime/host-bootstrap";
import {
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { isSubagentChildProcess } from "pi-cosmic-core/host-environment";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import {
  makePiSessionRuntimeSlot,
  PiSessionRuntimeError,
} from "pi-cosmic-core/runtime/session-runtime";
import { registerBackgroundTaskActivity } from "./boundary/host-activity.ts";
import {
  registerSubagentTaskNoticeDelivery,
  registerTaskNoticeDelivery,
} from "./boundary/host-notice.ts";
import { readHostShellSettings } from "./boundary/host-shell.ts";
import { discoverActivityView } from "pi-cosmic-ui/activity/view";
import { taskProjectionBridge } from "./boundary/host-ui.ts";
import { BackgroundTaskConfigStore, BackgroundTaskSettingsFiles } from "./config/store.ts";
import type { BackgroundTaskConfig } from "./config/schema.ts";
import { isActiveTaskState } from "./task/model.ts";
import { TASK_NOTICE_MESSAGE_TYPE } from "./task/notice.ts";
import { BackgroundTaskService } from "./task/service.ts";
import {
  backgroundTaskLayer,
  type BackgroundTaskApplication,
  type BackgroundTaskRuntimeError,
  type BackgroundTaskSessionInput,
} from "./layer.ts";
import { registerTasksCommand } from "./settings/controller.ts";
import { registerBackgroundTaskTool } from "./tools/background-task.ts";
import { renderTaskNotice } from "./ui/notice-message.ts";

interface BackgroundTaskSessionActivation extends BackgroundTaskSessionInput {
  readonly publicationOwner: MutableRef.MutableRef<boolean>;
  readonly publishesReplay: boolean;
}

const UNAVAILABLE = "Background Tasks aren't available in this session";
const IDLE_CHECK_INTERVAL = "50 millis";
const REPLACED = "Background Tasks session was replaced";
const CANCELLED = "Opening background tasks was cancelled";

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
  const bridge = taskProjectionBridge(pi.events);
  const replay = registerCodePreviewReplay(pi, { command: "tasks", tools: ["background_task"] });
  // Historical notices render without restoring delivery authority.
  pi.registerMessageRenderer(TASK_NOTICE_MESSAGE_TYPE, renderTaskNotice);
  let idleHost: ExtensionContext | undefined;
  // A subagent's tasks stop when its run ends, so it settles them before reporting. The published
  // projection follows every task state change and is empty once the activation retires.
  const subagentChild = isSubagentChildProcess();
  const deliverNotice = subagentChild
    ? registerSubagentTaskNoticeDelivery(pi, {
        activeTasks: () => Arr.filter(bridge.get().tasks, (task) => isActiveTaskState(task.state)),
      })
    : registerTaskNoticeDelivery(pi, {
        isIdle: () => invokeHostCallback(() => idleHost?.isIdle() ?? false, false),
        later: (check) => {
          slot.fork(Effect.sleep(IDLE_CHECK_INTERVAL).pipe(Effect.andThen(Effect.sync(check))));
        },
      });
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
    makeRuntime: (input) => {
      // Notices, like projections, belong to the activation that started their tasks.
      const isOwner = () => MutableRef.get(input.publicationOwner);
      return makePiManagedRuntime(
        pi,
        backgroundTaskLayer(
          input,
          (projection) => {
            if (isOwner()) bridge.publish(projection);
          },
          (notice) => {
            if (isOwner()) deliverNotice(notice, isOwner);
          },
        ),
        { agentDirectory: getAgentDir, packageName: "pi-background-task" },
      );
    },
    startup: Effect.fn("BackgroundTaskApplication.startup")(function* (input) {
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
        { shell: replay.shell, subagentChild },
      );
      if (publishesReplay) replay.publish();
      const sessionId = invokeHostCallback(() => {
        const id = ctx.sessionManager?.getSessionId?.();
        return Predicate.isString(id) && id.length > 0 ? id : undefined;
      }, undefined);
      currentConfig = prepared.config;
      idleHost = ctx;
      bridge.setFooterEnabled(prepared.config.showFooterStatus);
      bridge.setContext(ctx);
      openActivity = (signal) => {
        // A retired activation explains the failure even when its signal was also aborted.
        const interruption = (retired: string) =>
          !slot.isCurrent(token) ? retired : signal?.aborted ? CANCELLED : undefined;
        const unavailable = interruption(UNAVAILABLE);
        if (unavailable) return Promise.reject(new Error(unavailable));
        const capability = sessionId ? discoverActivityView(pi.events, sessionId) : undefined;
        return Promise.resolve(capability ? capability.open("tasks", signal) : false).then(
          (opened) => {
            const interrupted = interruption(REPLACED);
            if (interrupted) throw new Error(interrupted);
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
      idleHost = undefined;
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
            PiSessionRuntimeError.make({
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
    isAvailable: slot.isActive,
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
    if (!Predicate.isTagged(captured, "Captured") || captured.aborted) return slot.shutdown();
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted: isProjectTrusted(ctx),
          shell: readHostShellSettings(pi),
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
