import {
  ACTIVITY_LIMITS,
  registerRevisionedActivityProvider,
  type ActivityDetail,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { formatBytes } from "pi-cosmic-core/display";
import { exitStatusMeaning } from "pi-code-previews";
import { safeTextSuffix } from "pi-cosmic-core/text";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundTaskProjection,
  type BackgroundTaskState,
  type BackgroundTaskView,
} from "../task/model.ts";
import type { BackgroundTaskProjectionBridge } from "./host-ui.ts";
import { taskStateLabel } from "../ui/task-state.ts";
import { taskNoticeSummary } from "../ui/compact-summary.ts";

const ACTIVITY_STATUS = {
  starting: "pending",
  running: "running",
  stopping: "stopping",
  exited: "done",
  failed: "failed",
  stopped: "cancelled",
  timed_out: "failed",
} as const satisfies Record<BackgroundTaskState, ActivityItem["status"]>;

const failureMessages = (task: BackgroundTaskView): readonly string[] =>
  isActiveTaskState(task.state)
    ? []
    : Arr.flatMap(taskNoticeSummary(task).issues, (issue) =>
        // Dropped output is shown beside the output itself, not as the failure.
        issue.severity === "error" || issue.severity === "warning" ? [issue.message] : [],
      );

const firstFailure = (task: BackgroundTaskView): string | undefined => {
  const first = failureMessages(task)[0];
  return first === undefined
    ? undefined
    : sanitizeDiagnosticContent(sanitizeTerminalLine(first), { maximumLength: 512 });
};

const LATEST_LINE_EVENTS = 8;

/** The last line a live task printed, so its widget row shows progress rather than a timer. */
const latestOutputLine = (task: BackgroundTaskView): string | undefined => {
  if (!isActiveTaskState(task.state)) return undefined;
  for (const event of Arr.reverse(task.logs.slice(-LATEST_LINE_EVENTS))) {
    const line = Arr.findLast(Str.split(event.text, "\n"), (part) =>
      Str.isNonEmpty(Str.trim(part)),
    );
    if (Option.isSome(line))
      return sanitizeDiagnosticContent(sanitizeTerminalLine(Str.trim(line.value)), {
        maximumLength: 200,
      });
  }
  return undefined;
};

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
        // A failure leads with its cause and live work with its latest output, so the widget
        // can say why or how far without opening it.
        summary: firstFailure(task) ?? latestOutputLine(task) ?? taskStateLabel(task.state),
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
                  label: "Clear all finished",
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

const exitField = (task: BackgroundTaskView): string => {
  const code = Predicate.isNumber(task.exitCode)
    ? withMeaning(String(task.exitCode), exitStatusMeaning(task.exitCode))
    : task.exitCode === null
      ? "unknown"
      : "none";
  const signal = task.signal
    ? withMeaning(task.signal, exitStatusMeaning(undefined, task.signal))
    : "none";
  return `code ${code} · signal ${signal}`;
};

// Local wall-clock times; the item's own ages and elapsed time cover the relative view.
const clockTime = (epochMilliseconds: number): string =>
  Option.match(DateTime.make(epochMilliseconds), {
    onNone: () => "unknown",
    onSome: DateTime.formatLocal({
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }),
  });

const logTail = (task: BackgroundTaskView): string => {
  let remaining = 12_000;
  const chunks: string[] = [];
  for (let index = task.logs.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const text = safeTextSuffix(task.logs[index]?.text ?? "", remaining);
    chunks.push(text);
    remaining -= text.length;
  }
  return Arr.join(Arr.reverse(chunks), "");
};

const bounded = (text: string, maximumLength: number): string =>
  sanitizeDiagnosticContent(text, { maximumLength });

/** What went wrong, in the same words the task's transcript row uses. */
const failureSummary = (task: BackgroundTaskView): string | undefined => {
  const messages = failureMessages(task);
  return messages.length ? bounded(Arr.join(messages, "\n"), 1_000) : undefined;
};

/** Output shown first, with the command for context; identity sits behind Technical. */
export function backgroundTaskActivityDetail(
  projection: BackgroundTaskProjection,
  id: string,
): ActivityDetail | undefined {
  const task = Option.getOrUndefined(
    Arr.findFirst(projection.tasks, (candidate) => candidate.id === id),
  );
  if (!task) return undefined;
  const failure = failureSummary(task);
  const output = logTail(task);
  const dropped = task.droppedLogBytes > 0 ? `${formatBytes(task.droppedLogBytes)} not kept` : "";
  return {
    sections: [
      ...(failure ? [{ body: failure }] : []),
      {
        title: dropped ? `Output · earlier ${dropped}` : "Output",
        body: output ? bounded(output, 12_000) : "No output yet",
      },
      { title: "Command", body: bounded(task.command, 2_000) },
    ],
    technical: [
      { label: "ID", value: task.id },
      { label: "PID", value: task.pid === undefined ? "none" : String(task.pid) },
      { label: "Exit", value: exitField(task) },
      { label: "Started", value: clockTime(task.startedAt) },
      ...(task.endedAt === undefined ? [] : [{ label: "Ended", value: clockTime(task.endedAt) }]),
      { label: "Directory", value: bounded(task.cwd, 1_000) },
      { label: "Log cursor", value: String(task.logCursor) },
      ...(task.droppedLogBytes > 0
        ? [{ label: "Dropped", value: formatBytes(task.droppedLogBytes) }]
        : []),
      ...(task.error ? [{ label: "Error", value: bounded(task.error, 1_000) }] : []),
    ],
  };
}

export function registerBackgroundTaskActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: BackgroundTaskProjectionBridge;
  readonly isCurrent: () => boolean;
  readonly stop: (id: string, signal: AbortSignal) => Promise<void>;
  readonly clear: (signal: AbortSignal) => Promise<void>;
  /** Reports whether Activity currently presents these tasks, so fallback status can step aside. */
  readonly onAvailability?: (available: boolean) => void;
}): () => void {
  const dispose = registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: "pi-background-task",
    isCurrent: options.isCurrent,
    items: () => backgroundTaskActivityItems(options.bridge.get()),
    detail: (item) =>
      backgroundTaskActivityDetail(options.bridge.get(), item.id) ?? { sections: [] },
    act: (item, action, signal) => {
      if (action === "clear") return options.clear(signal);
      if (action === "stop") return options.stop(item.id, signal);
      throw new Error("Background task action is unavailable.");
    },
    subscriptions: [options.bridge.subscribe],
    onAvailability: (available, current) => options.onAvailability?.(current() && available),
  });
  return () => {
    dispose();
    options.onAvailability?.(false);
  };
}
