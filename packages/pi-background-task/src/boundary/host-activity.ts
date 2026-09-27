import {
  registerRevisionedActivityProvider,
  type ActivityEvents,
  type ActivityItem,
} from "pi-cosmic-ui/activity";
import { sanitizeDiagnosticContent } from "pi-cosmic-core";
import { isActiveTaskState, type BackgroundTaskProjection } from "../task/model.ts";
import type { BackgroundTaskProjectionBridge } from "./host-ui.ts";
import { taskStateLabel } from "../ui/task-state.ts";

export function backgroundTaskActivityItems(
  projection: BackgroundTaskProjection,
): readonly ActivityItem[] {
  return Object.freeze(
    projection.tasks.map((task) => {
      const title = sanitizeDiagnosticContent(task.name ?? task.command, { maximumLength: 512 });
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
                }),
              ]
            : [],
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
    [`${task.name ?? task.id}: ${task.state}`, task.command, task.cwd, task.error ?? ""].join("\n"),
    { maximumLength: 4_000 },
  );
  return sanitizeDiagnosticContent(`${header}\n\n${chunks.reverse().join("")}`, {
    maximumLength: 16_384,
  });
}

/** Commands have no ownerRunId; keep them at the root and never infer ancestry. */
export function registerBackgroundTaskActivity(options: {
  readonly events: ActivityEvents;
  readonly sessionId: string;
  readonly bridge: BackgroundTaskProjectionBridge;
  readonly isCurrent: () => boolean;
  readonly stop: (id: string, signal: AbortSignal) => Promise<void>;
}): () => void {
  return registerRevisionedActivityProvider(options.events, {
    sessionId: options.sessionId,
    providerId: "pi-background-task",
    isCurrent: options.isCurrent,
    items: () => backgroundTaskActivityItems(options.bridge.get()),
    detail: (item) => backgroundTaskActivityDetail(options.bridge.get(), item.id) ?? "",
    act: (item, action, signal) => {
      if (action !== "stop") throw new Error("Background task action is unavailable.");
      return options.stop(item.id, signal);
    },
    subscriptions: [options.bridge.subscribe],
  });
}
