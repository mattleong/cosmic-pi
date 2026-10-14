import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { outputFailureLine } from "pi-code-previews";
import type {
  LocalProcessError,
  LocalProcessExit,
  LocalProcessHandle,
} from "../boundary/local-process.ts";
import type { BackgroundRuntimeClosedError } from "./errors.ts";
import { LogBuffer, readLogBuffer } from "./log-buffer.ts";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundTaskProjection,
  type BackgroundTaskStatus,
} from "./model.ts";

export interface TaskRecord {
  snapshot: BackgroundTaskStatus;
  readonly logs: LogBuffer;
  wake: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<BackgroundTaskStatus>;
  readonly handleReady: Deferred.Deferred<
    LocalProcessHandle,
    LocalProcessError | BackgroundRuntimeClosedError
  >;
  terminalOutcome?: "stopped" | "timed_out";
  ingressDroppedObserved: number;
  awaiters: number;
}

export type TaskRegistry = Map<string, TaskRecord>;

export const taskRecord = (snapshot: BackgroundTaskStatus): TaskRecord => ({
  snapshot,
  logs: new LogBuffer(),
  wake: Deferred.makeUnsafe<void>(),
  completion: Deferred.makeUnsafe<BackgroundTaskStatus>(),
  handleReady: Deferred.makeUnsafe(),
  ingressDroppedObserved: 0,
  awaiters: 0,
});

export const logFields = (logs: LogBuffer) => ({
  logCursor: logs.nextCursor - 1,
  droppedLogBytes: logs.droppedBytes,
});

export const wakeTaskRecord = (record: TaskRecord) => {
  const current = record.wake;
  record.wake = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(current, Effect.void);
};

const recentOutputLines = (record: TaskRecord): string[] =>
  readLogBuffer(record.snapshot.id, record.logs, record.snapshot.state, { tailLines: 200 })
    .events.map((event) => event.text)
    .join("")
    .split(/\r?\n/u);

export const completedSnapshot = (
  record: TaskRecord,
  exit: LocalProcessExit,
  endedAt: number,
): BackgroundTaskStatus => {
  const state = record.terminalOutcome ?? (exit.exitCode !== 0 ? "failed" : "exited");
  const failureCause =
    state === "failed" ? outputFailureLine(recentOutputLines(record)) : undefined;
  return {
    ...record.snapshot,
    state,
    endedAt,
    exitCode: exit.exitCode,
    ...(exit.signal && { signal: exit.signal }),
    ...(failureCause && { failureCause }),
    ...logFields(record.logs),
  };
};

export const activeRecords = (tasks: TaskRegistry): TaskRecord[] =>
  [...tasks.values()].filter((record) => isActiveTaskState(record.snapshot.state));

export const registryProjection = (tasks: TaskRegistry): BackgroundTaskProjection =>
  Object.freeze({
    tasks: Object.freeze(
      sortTasksByActivity(
        [...tasks.values()].map((record) =>
          Object.freeze({
            ...record.snapshot,
            logs: record.logs.events,
            awaited: record.awaiters > 0,
          }),
        ),
      ),
    ),
  });

const oldestLogOwner = (tasks: TaskRegistry): TaskRecord | undefined => {
  let selected: TaskRecord | undefined;
  for (const record of tasks.values()) {
    const first = record.logs.oldestEvent;
    const selectedFirst = selected?.logs.oldestEvent;
    if (first && (!selectedFirst || first.timestamp < selectedFirst.timestamp)) selected = record;
  }
  return selected;
};

export const enforceRetainedLogBudget = (tasks: TaskRegistry, budget: number) => {
  let total = [...tasks.values()].reduce((sum, record) => sum + record.logs.bytes, 0);
  while (total > budget) {
    const selected = oldestLogOwner(tasks);
    const dropped = selected?.logs.oldestEvent;
    if (!selected || !dropped) break;
    selected.logs.dropOldest();
    total -= dropped.bytes;
    selected.snapshot = { ...selected.snapshot, ...logFields(selected.logs) };
    wakeTaskRecord(selected);
  }
};

export const trimRetention = (tasks: TaskRegistry, maxRetained: number) => {
  const completed = [...tasks.values()]
    .filter((record) => !isActiveTaskState(record.snapshot.state))
    .toSorted((left, right) => (left.snapshot.endedAt ?? 0) - (right.snapshot.endedAt ?? 0));
  const evicted = completed.slice(0, Math.max(0, completed.length - maxRetained));
  for (const record of evicted) tasks.delete(record.snapshot.id);
};

export const clearFinished = (tasks: TaskRegistry): number => {
  let removed = 0;
  for (const [id, record] of tasks) {
    if (isActiveTaskState(record.snapshot.state)) continue;
    tasks.delete(id);
    removed += 1;
  }
  return removed;
};
