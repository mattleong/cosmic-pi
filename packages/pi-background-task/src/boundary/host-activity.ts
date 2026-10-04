import {
  ACTIVITY_LIMITS,
  registerRevisionedActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundTaskProjection,
} from "../task/model.ts";
import type { BackgroundTaskProjectionBridge } from "./host-ui.ts";
import { taskStateLabel } from "../ui/task-state.ts";

/**
 * One snapshot holds at most `ACTIVITY_LIMITS.items`, or the host rejects all of it. Retained
 * finished tasks can exceed that, so active tasks come first and the oldest finished ones drop.
 */
export function backgroundTaskActivityItems(
  projection: BackgroundTaskProjection,
): readonly ActivityItem[] {
  const tasks = sortTasksByActivity(projection.tasks).slice(0, ACTIVITY_LIMITS.items);
  return Object.freeze(
    tasks.map((task) => {
      const title = sanitizeDiagnosticContent(task.name ?? task.command, {
        maximumLength: ACTIVITY_LIMITS.title,
      });
      const item: ActivityItem = {
        id: task.id,
        kind: "command" as const,
        title,
        status:
          task.state === "starting"
            ? ("pending" as const)
            : task.state === "stopping"
              ? ("stopping" as const)
              : isActiveTaskState(task.state)
                ? ("running" as const)
                : task.state === "failed" || task.state === "timed_out"
                  ? ("failed" as const)
                  : task.state === "stopped"
                    ? ("cancelled" as const)
                    : ("done" as const),
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
      };
      if (task.endedAt !== undefined) Object.assign(item, { endedAt: task.endedAt });
      return Object.freeze(item);
    }),
  );
}

/** Materialize only the selected task's bounded tail, never a fleet-wide log snapshot. */
export function backgroundTaskActivityDetail(
  projection: BackgroundTaskProjection,
  id: string,
): string | undefined {
  const task = projection.tasks.find((task) => task.id === id);
  if (!task) return undefined;
  let remaining = 12_000;
  const chunks: string[] = [];
  for (let index = task.logs.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const text = task.logs[index]!.text.slice(-remaining);
    chunks.push(text);
    remaining -= text.length;
  }
  const header = sanitizeDiagnosticContent(
    [
      `${task.name ?? task.id}: ${task.state}`,
      task.command,
      task.cwd,
      `ID: ${task.id} · PID: ${task.pid ?? "none"}`,
      `Exit: ${task.exitCode ?? "none"} · signal: ${task.signal ?? "none"}`,
      `Started: ${task.startedAt} · ended: ${task.endedAt ?? "none"}`,
      `Log cursor: ${task.logCursor} · dropped bytes: ${task.droppedLogBytes}`,
      task.error ?? "",
    ].join("\n"),
    { maximumLength: 4_000 },
  );
  return sanitizeDiagnosticContent(`${header}\n\n${chunks.reverse().join("")}`, {
    maximumLength: ACTIVITY_LIMITS.detail,
  });
}

/** Commands have no ownerRunId; keep them at the root and never infer ancestry. */
export function registerBackgroundTaskActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: BackgroundTaskProjectionBridge;
  readonly isCurrent: () => boolean;
  readonly stop: (id: string, signal: AbortSignal) => Promise<void>;
  readonly clear?: (signal: AbortSignal) => Promise<void>;
}): () => void {
  return registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: "pi-background-task",
    isCurrent: options.isCurrent,
    items: () => backgroundTaskActivityItems(options.bridge.get()),
    detail: (item) => backgroundTaskActivityDetail(options.bridge.get(), item.id) ?? "",
    act: (item, action, signal) => {
      if (action === "clear" && options.clear) return options.clear(signal);
      if (action === "stop") return options.stop(item.id, signal);
      throw new Error("Background task action is unavailable.");
    },
    subscriptions: [options.bridge.subscribe],
  });
}
