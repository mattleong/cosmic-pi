import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Str from "effect/String";
import { outputFailureLine } from "pi-code-previews";
import type {
  LocalProcessError,
  LocalProcessExit,
  LocalProcessHandle,
} from "../boundary/local-process.ts";
import type { BackgroundRuntimeClosedError } from "./errors.ts";
import { LogBuffer, ownedText, readLogBuffer } from "./log-buffer.ts";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundLogStream,
  type BackgroundTaskProjection,
  type BackgroundTaskStatus,
} from "./model.ts";
import { plainTerminalText, TerminalTextNormalizer } from "./terminal-text.ts";

export interface TaskRecord {
  snapshot: BackgroundTaskStatus;
  readonly logs: LogBuffer;
  /** Per-stream intake state; escape sequences split across writes stay with their stream. */
  readonly terminal: Readonly<Record<BackgroundLogStream, TerminalTextNormalizer>>;
  wake: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<BackgroundTaskStatus>;
  readonly handleReady: Deferred.Deferred<
    LocalProcessHandle,
    LocalProcessError | BackgroundRuntimeClosedError
  >;
  terminalOutcome?: "stopped" | "timed_out";
  /** The first stop's grace window is still running; internal stops join it. */
  graceWindowOpen: boolean;
  ingressDroppedObserved: number;
  awaiters: number;
}

export type TaskRegistry = Map<string, TaskRecord>;

export const taskRecord = (snapshot: BackgroundTaskStatus): TaskRecord => ({
  snapshot,
  logs: new LogBuffer(),
  terminal: { stdout: new TerminalTextNormalizer(), stderr: new TerminalTextNormalizer() },
  wake: Deferred.makeUnsafe<void>(),
  completion: Deferred.makeUnsafe<BackgroundTaskStatus>(),
  handleReady: Deferred.makeUnsafe(),
  graceWindowOpen: false,
  ingressDroppedObserved: 0,
  awaiters: 0,
});

export const logFields = (logs: LogBuffer) => ({
  logCursor: logs.latestCursor,
  droppedLogBytes: logs.droppedBytes,
});

export const wakeTaskRecord = (record: TaskRecord) => {
  const current = record.wake;
  record.wake = Deferred.makeUnsafe<void>();
  Deferred.doneUnsafe(current, Effect.void);
};

const recentOutputLines = (record: TaskRecord): string[] =>
  Str.split(
    Arr.join(
      Arr.map(
        readLogBuffer(record.snapshot.id, record.logs, record.snapshot.state, { tailLines: 200 })
          .events,
        (event) => plainTerminalText(event.text),
      ),
      "",
    ),
    /\r?\n/u,
  );

export const completedSnapshot = (
  record: TaskRecord,
  exit: LocalProcessExit,
  endedAt: number,
): BackgroundTaskStatus => {
  const state = record.terminalOutcome ?? (exit.exitCode !== 0 ? "failed" : "exited");
  // The cause outlives the output it was read from, so it keeps its own copy.
  const cause = state === "failed" ? outputFailureLine(recentOutputLines(record)) : undefined;
  const failureCause = cause && ownedText(cause);
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
  Arr.filter([...tasks.values()], (record) => isActiveTaskState(record.snapshot.state));

export const registryProjection = (tasks: TaskRegistry): BackgroundTaskProjection =>
  Object.freeze({
    tasks: Object.freeze(
      sortTasksByActivity(
        Arr.map([...tasks.values()], (record) =>
          Object.freeze({
            ...record.snapshot,
            logs: record.logs.events,
            awaited: record.awaiters > 0,
          }),
        ),
      ),
    ),
  });

/**
 * The record holding the oldest retained event, earliest in the registry on ties, and whether a
 * fresh scan would still choose it once its oldest event has the given timestamp.
 */
const oldestLogOwner = (tasks: TaskRegistry) => {
  let owner: TaskRecord | undefined;
  let ownerAt = Number.POSITIVE_INFINITY;
  let nextAt = Number.POSITIVE_INFINITY;
  let nextFollows = false;
  for (const record of tasks.values()) {
    const at = record.logs.oldestEvent?.timestamp;
    if (at === undefined) continue;
    if (at < ownerAt) {
      nextAt = ownerAt;
      nextFollows = false;
      owner = record;
      ownerAt = at;
    } else if (at < nextAt) {
      nextAt = at;
      nextFollows = true;
    }
  }
  return (
    owner && {
      owner,
      stillOldest: (at: number) => at < nextAt || (at === nextAt && nextFollows),
    }
  );
};

export const enforceRetainedLogBudget = (tasks: TaskRegistry, budget: number) => {
  let total = 0;
  for (const record of tasks.values()) total += record.logs.chargedBytes;
  const trimmed = new Set<TaskRecord>();
  while (total > budget) {
    const oldest = oldestLogOwner(tasks);
    if (!oldest) break;
    const { logs } = oldest.owner;
    trimmed.add(oldest.owner);
    do {
      const before = logs.chargedBytes;
      logs.dropOldest();
      total -= before - logs.chargedBytes;
    } while (
      total > budget &&
      logs.oldestEvent !== undefined &&
      oldest.stillOldest(logs.oldestEvent.timestamp)
    );
  }
  // Each trimmed record publishes its final log fields and wakes its readers once.
  for (const record of trimmed) {
    record.snapshot = { ...record.snapshot, ...logFields(record.logs) };
    wakeTaskRecord(record);
  }
};

export const trimRetention = (tasks: TaskRegistry, maxRetained: number) => {
  const completed = Arr.sortWith(
    Arr.filter([...tasks.values()], (record) => !isActiveTaskState(record.snapshot.state)),
    (record: TaskRecord) => record.snapshot.endedAt ?? 0,
    Order.Number,
  );
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
