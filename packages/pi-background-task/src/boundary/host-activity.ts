import {
  ACTIVITY_LIMITS,
  registerRevisionedActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { exitStatusMeaning } from "pi-code-previews";
import { safeTextSuffix } from "pi-cosmic-core/text";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundTaskProjection,
  type BackgroundTaskState,
  type BackgroundTaskView,
} from "../task/model.ts";
import type { BackgroundTaskProjectionBridge } from "./host-ui.ts";
import { taskStateLabel } from "../ui/task-state.ts";

const ACTIVITY_STATUS = {
  starting: "pending",
  running: "running",
  stopping: "stopping",
  exited: "done",
  failed: "failed",
  stopped: "cancelled",
  timed_out: "failed",
} as const satisfies Record<BackgroundTaskState, ActivityItem["status"]>;

export function backgroundTaskActivityItems(
  projection: BackgroundTaskProjection,
): readonly ActivityItem[] {
  const tasks = sortTasksByActivity(projection.tasks).slice(0, ACTIVITY_LIMITS.items);
  return Object.freeze(
    Arr.map(tasks, (task) => {
      const title = sanitizeDiagnosticContent(task.name ?? task.command, {
        maximumLength: ACTIVITY_LIMITS.title,
      });
      const item: ActivityItem = {
        id: task.id,
        kind: "command",
        title,
        status: ACTIVITY_STATUS[task.state],
        revision: `${task.startedAt}:${task.state}:${task.logCursor}`,
        summary: taskStateLabel(task.state),
        awaited: task.awaited === true,
        startedAt: task.startedAt,
        updatedAt: task.endedAt ?? task.logs.at(-1)?.timestamp ?? task.startedAt,
        actions: Object.freeze(
          isActiveTaskState(task.state)
            ? [
                Object.freeze({
                  id: "stop",
                  label: "Stop",
                  confirmation: `Stop "${title}" and its process tree?`,
                  handoff: false,
                }),
              ]
            : [
                Object.freeze({
                  id: "clear",
                  label: "Clear finished tasks",
                  confirmation:
                    "Clear all finished tasks from this session? Running tasks keep running.",
                  handoff: false,
                }),
              ],
        ),
        ...(task.endedAt !== undefined && { endedAt: task.endedAt }),
      };
      return Object.freeze(item);
    }),
  );
}

const withMeaning = (value: string, meaning: string | undefined): string =>
  meaning ? `${value} (${meaning})` : value;

const exitLine = (task: BackgroundTaskView): string => {
  const code = Predicate.isNumber(task.exitCode)
    ? withMeaning(String(task.exitCode), exitStatusMeaning(task.exitCode))
    : task.exitCode === null
      ? "unknown"
      : "none";
  const signal = task.signal
    ? withMeaning(task.signal, exitStatusMeaning(undefined, task.signal))
    : "none";
  return `Exit: ${code} · signal: ${signal}`;
};

export function backgroundTaskActivityDetail(
  projection: BackgroundTaskProjection,
  id: string,
): string | undefined {
  const task = Option.getOrUndefined(
    Arr.findFirst(projection.tasks, (candidate) => candidate.id === id),
  );
  if (!task) return undefined;
  let remaining = 12_000;
  const chunks: string[] = [];
  for (let index = task.logs.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const text = safeTextSuffix(task.logs[index]?.text ?? "", remaining);
    chunks.push(text);
    remaining -= text.length;
  }
  // The cause is an output line, so it drops terminal controls before the shared redaction.
  const cause = task.failureCause && sanitizeTerminalLine(task.failureCause);
  const header = sanitizeDiagnosticContent(
    Arr.join(
      [
        `${task.name ?? task.id}: ${task.state}`,
        task.command,
        task.cwd,
        `ID: ${task.id} · PID: ${task.pid ?? "none"}`,
        exitLine(task),
        `Started: ${task.startedAt} · ended: ${task.endedAt ?? "none"}`,
        `Log cursor: ${task.logCursor} · dropped bytes: ${task.droppedLogBytes}`,
        ...(task.error ? [`Error: ${task.error}`] : []),
        ...(cause ? [`Cause: ${cause}`] : []),
      ],
      "\n",
    ),
    { maximumLength: 4_000 },
  );
  return sanitizeDiagnosticContent(`${header}\n\n${Arr.join(Arr.reverse(chunks), "")}`, {
    maximumLength: ACTIVITY_LIMITS.detail,
  });
}

export function registerBackgroundTaskActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: BackgroundTaskProjectionBridge;
  readonly isCurrent: () => boolean;
  readonly stop: (id: string, signal: AbortSignal) => Promise<void>;
  readonly clear: (signal: AbortSignal) => Promise<void>;
}): () => void {
  return registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: "pi-background-task",
    isCurrent: options.isCurrent,
    items: () => backgroundTaskActivityItems(options.bridge.get()),
    detail: (item) => backgroundTaskActivityDetail(options.bridge.get(), item.id) ?? "",
    act: (item, action, signal) => {
      if (action === "clear") return options.clear(signal);
      if (action === "stop") return options.stop(item.id, signal);
      throw new Error("Background task action is unavailable.");
    },
    subscriptions: [options.bridge.subscribe],
  });
}
