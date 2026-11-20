import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as Path from "effect/Path";
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
  registerTaskMessageOrigins,
  registerTaskNoticeDelivery,
} from "./boundary/host-notice.ts";
import { readHostShellSettings } from "./boundary/host-shell.ts";
import { discoverActivityView } from "pi-cosmic-ui/activity/view";
import { taskProjectionBridge } from "./boundary/host-ui.ts";
import type { HostShellSettings } from "./boundary/local-process.ts";
import {
  parkTaskOwner,
  takeTaskOwner,
  taskOwner,
  taskSessionKey,
  type TaskOwner,
  type TaskSessionKey,
} from "./boundary/task-owner.ts";
import { BackgroundTaskConfigStore, BackgroundTaskSettingsFiles } from "./config/store.ts";
import type { BackgroundTaskConfig } from "./config/schema.ts";
import { isActiveTaskState } from "./task/model.ts";
import { TASK_NOTICE_MESSAGE_TYPE } from "./task/notice.ts";
import { BackgroundTaskService } from "./task/service.ts";
import { backgroundTaskHostLayer } from "./layer.ts";
import type * as Layer from "effect/Layer";
import { registerTasksCommand } from "./settings/controller.ts";
import { registerBackgroundTaskTool } from "./tools/background-task.ts";
import { renderTaskNotice } from "./ui/notice-message.ts";

type HostLayer = ReturnType<typeof backgroundTaskHostLayer>;
type TaskEnvironment = BackgroundTaskService | Path.Path;

interface BackgroundTaskSessionActivation {
  readonly ctx: ExtensionContext;
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly shell: HostShellSettings;
  readonly key: TaskSessionKey | undefined;
  readonly reload: boolean;
  readonly publishesReplay: boolean;
  readonly callers: AbortController;
  readonly calls: Set<Promise<unknown>>;
  owner?: TaskOwner;
  retainForReload?: boolean;
}

const UNAVAILABLE = "Background tasks aren't available in this session";
const IDLE_CHECK_INTERVAL = "50 millis";
const REPLACED = "The background tasks session was replaced";
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
  registerTaskMessageOrigins(pi);
  let idleHost: ExtensionContext | undefined;
  let activation: BackgroundTaskSessionActivation | undefined;
  // Detach before the notice wake's own shutdown handler closes delivery.
  pi.on("session_shutdown", (event) => {
    if (activation && event.reason === "reload") activation.retainForReload = true;
    replay.retire();
    return slot.shutdown();
  });
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
  // The Activity widget lists running tasks, so the footer line is only a fallback without it.
  let activityPresentsTasks = false;
  const syncFooter = () =>
    bridge.setFooterEnabled((currentConfig?.showFooterStatus ?? false) && !activityPresentsTasks);

  const slot = makePiSessionRuntimeSlot<
    BackgroundTaskSessionActivation,
    Layer.Success<HostLayer>,
    PiSessionRuntimeError,
    Layer.Error<HostLayer>,
    {
      readonly config: BackgroundTaskConfig;
      readonly scheduler: CodePreviewSchedulerServiceContract;
    }
  >({
    makeRuntime: (input) => {
      const runtime = makePiManagedRuntime(pi, backgroundTaskHostLayer(input));
      return {
        ...runtime,
        dispose: () =>
          Promise.allSettled([
            runtime.dispose(),
            // The task scope is independent, so cancel and join old tool calls before reattaching.
            Promise.allSettled(input.calls).then(() => {
              const owner = input.owner;
              delete input.owner;
              if (!owner) return input.key ? takeTaskOwner(input.key, false).cleanup : undefined;
              if (input.retainForReload && input.key) return parkTaskOwner(input.key, owner);
              return owner.dispose();
            }),
          ]).then(() => undefined),
      };
    },
    startup: Effect.fn("BackgroundTaskApplication.startup")(function* (input) {
      yield* bestEffortHostBootstrap("pi-background-task.preview-settings", (signal) =>
        boundaries.loadSettings(input.cwd, input.projectTrusted, signal),
      );
      const config = yield* BackgroundTaskConfigStore;
      const scheduler = yield* CodePreviewSchedulerService;
      // Leave the lease's expiry armed while preview settings and the host layer load.
      yield* Effect.tryPromise({
        try: (signal) => {
          const parked = input.key ? takeTaskOwner(input.key, input.reload) : {};
          const owner = parked.owner ?? taskOwner();
          input.owner = owner;
          return Promise.resolve(parked.cleanup).then(() =>
            owner.run(
              BackgroundTaskService.use((service) => service.configure(config, input.shell)),
              signal,
            ),
          );
        },
        catch: () => PiSessionRuntimeError.make({ operation: "start", message: UNAVAILABLE }),
      });
      return { config, scheduler };
    }),
    onActivated: (input, token, prepared) => {
      const { ctx, publishesReplay } = input;
      activation = input;
      const isCurrent = () => slot.isCurrent(token);
      registerBackgroundTaskTool(
        pi,
        {
          run: (effect, signal) => runTask(input, isCurrent, effect, signal),
          scheduleAnimation: (interval, tick) =>
            isCurrent() ? prepared.scheduler.schedule(interval, tick) : undefined,
        },
        { shell: replay.shell, subagentChild },
      );
      if (publishesReplay) replay.publish();
      const sessionId = input.key?.sessionId;
      currentConfig = prepared.config;
      idleHost = ctx;
      syncFooter();
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
          isCurrent,
          stop: (id, signal) =>
            runTask(
              input,
              isCurrent,
              BackgroundTaskService.use((service) => Effect.asVoid(service.stop(id))),
              signal,
            ),
          clear: (signal) =>
            runTask(
              input,
              isCurrent,
              BackgroundTaskService.use((service) => Effect.asVoid(service.clear)),
              signal,
            ),
          onAvailability: (available) => {
            activityPresentsTasks = available;
            syncFooter();
          },
        });
      input.owner?.attach({
        publish: (projection) => {
          if (isCurrent()) bridge.publish(projection);
        },
        notify: (notice) => {
          if (isCurrent()) deliverNotice(notice, isCurrent);
        },
      });
    },
    onDeactivated: (input) => {
      input.owner?.detach();
      input.callers.abort();
      activation = undefined;
      currentConfig = undefined;
      idleHost = undefined;
      openActivity = undefined;
      releaseActivity?.();
      releaseActivity = undefined;
      bridge.clear();
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(
        ctx,
        "Background tasks couldn't start; run /reload to try again",
        "warning",
      );
    },
  });

  const runTask = <A, E>(
    input: BackgroundTaskSessionActivation | undefined,
    isCurrent: () => boolean,
    effect: Effect.Effect<A, E, TaskEnvironment>,
    signal?: AbortSignal,
  ): Promise<A> => {
    if (!input?.owner || !isCurrent())
      return Promise.reject(PiSessionRuntimeError.make({ operation: "run", message: UNAVAILABLE }));
    const callers = input.callers.signal;
    const call = input.owner.run(effect, signal ? AbortSignal.any([callers, signal]) : callers);
    const tracked = call.finally(() => {
      input.calls.delete(tracked);
    });
    input.calls.add(tracked);
    return tracked;
  };
  registerTasksCommand(pi, {
    captureAuthority: slot.captureAuthority,
    isAvailable: slot.isActive,
    openActivity: (signal) =>
      openActivity ? openActivity(signal) : Promise.reject(new Error(UNAVAILABLE)),
    config: () => currentConfig,
    read: (location) => slot.run(BackgroundTaskSettingsFiles.use((files) => files.read(location))),
    write: (location, id, value) =>
      slot.run(BackgroundTaskSettingsFiles.use((files) => files.write(location, id, value))),
  });

  const startSession = (ctx: ExtensionContext, publishesReplay: boolean, reload = false) => {
    const captured = captureSessionHost(ctx);
    if (!Predicate.isTagged(captured, "Captured")) return slot.shutdown();
    const projectTrusted = isProjectTrusted(ctx);
    const key = taskSessionKey(ctx, captured.cwd, projectTrusted);
    if (captured.aborted) {
      const discarded = key ? takeTaskOwner(key, false) : {};
      return slot.shutdown().then(() => discarded.cleanup);
    }
    return slot
      .start(
        {
          ctx,
          cwd: captured.cwd,
          projectTrusted,
          shell: readHostShellSettings(pi),
          key,
          reload,
          publishesReplay,
          callers: new AbortController(),
          calls: new Set(),
        },
        captured.signal,
      )
      .then(() => undefined);
  };

  pi.on("session_start", (event, ctx) =>
    startSession(ctx, true, event.reason === "reload").finally(replay.finishStartup),
  );
  pi.on("session_tree", (_event, ctx) => startSession(ctx, false));

  pi.on("turn_end", (_event, ctx) => {
    if (slot.isActive()) bridge.setContext(ctx);
  });
}
