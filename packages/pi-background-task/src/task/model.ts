import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import type {
  BACKGROUND_TASK_NOTIFY_FILTERS,
  BackgroundLogMetadataSchema,
  BackgroundOutputSkipSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskStateSchema,
  BackgroundTaskWaitResultSchema,
} from "./schema.ts";
import { countLabel, formatBytes } from "pi-cosmic-core/display";

export type BackgroundTaskState = typeof BackgroundTaskStateSchema.Type;
export type BackgroundTaskSnapshot = typeof BackgroundTaskSnapshotSchema.Type;
export type BackgroundTaskStatus = BackgroundTaskSnapshot & { readonly failureCause?: string };
export type BackgroundTaskStatusWait = Omit<BackgroundTaskWaitResult, "snapshot" | "tail"> & {
  readonly snapshot: BackgroundTaskStatus;
  readonly appliedWaitSeconds: number;
  /** The newest retained output when the wait returned. */
  readonly recent: BackgroundLogSlice;
};
export type BackgroundLogMetadata = typeof BackgroundLogMetadataSchema.Type;
export type BackgroundOutputSkip = typeof BackgroundOutputSkipSchema.Type;
export type BackgroundTaskWaitResult = typeof BackgroundTaskWaitResultSchema.Type;

export type BackgroundLogStream = "stdout" | "stderr";

export interface BackgroundLogEvent {
  readonly cursor: number;
  readonly stream: BackgroundLogStream;
  /**
   * Normalized plain text: printable text, newlines, and tabs only. Empty only for the event that
   * ends a finished task's output after output lost at its end.
   */
  readonly text: string;
  readonly timestamp: number;
  readonly bytes: number;
  /** Bytes of output lost just before this event, which never reached the buffer. */
  readonly droppedBefore?: number;
}

/**
 * Retained output a read selected. What it skipped depends on which of the events a result
 * returns, so each page computes its own with `skippedWithin`.
 */
export interface BackgroundLogSlice extends Omit<BackgroundLogMetadata, "skipped"> {
  readonly events: ReadonlyArray<BackgroundLogEvent>;
  /** Text bytes the task retains in total, including events outside this slice. */
  readonly retainedBytes: number;
  /** Output the read asked for that was discarded before the first event, such as evicted output. */
  readonly discardedBefore?: BackgroundOutputSkip;
}

/** A log read, with the identity of the task record it was read from. */
export interface BackgroundTaskLogs extends BackgroundLogSlice {
  readonly task: Pick<BackgroundTaskSnapshot, "name" | "command">;
}

/** A stop request's result. `alreadyFinished` means the task had ended, so nothing was stopped. */
export interface BackgroundTaskStopResult {
  readonly snapshot: BackgroundTaskStatus;
  readonly alreadyFinished: boolean;
}

export interface BackgroundTaskView extends BackgroundTaskSnapshot {
  readonly awaited?: boolean;
  readonly logs: ReadonlyArray<BackgroundLogEvent>;
}

export interface BackgroundTaskProjection {
  readonly tasks: ReadonlyArray<BackgroundTaskView>;
}

/** Which finish sends the agent a notice: any, or only a failure or timeout. */
export type BackgroundTaskNotifyFilter = (typeof BACKGROUND_TASK_NOTIFY_FILTERS)[number];

export interface StartBackgroundTask {
  readonly command: string;
  readonly cwd: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
  readonly notify?: BackgroundTaskNotifyFilter;
}

/** A task that finished with a notice due to the agent. */
export interface BackgroundTaskNotice {
  readonly task: BackgroundTaskStatus;
  /** The newest retained output when the task finished. */
  readonly recent: BackgroundLogSlice;
  /** The registry still lists the task, so its logs can be read. */
  readonly retained: boolean;
}

export interface ReadBackgroundLogs {
  readonly id: string;
  readonly afterCursor?: number;
  readonly tailLines?: number;
  readonly waitSeconds?: number;
}

export interface WaitForBackgroundTask {
  readonly id: string;
  readonly until: "exit" | "output";
  /** Literal alternatives; an output wait matches the first of them to appear. */
  readonly contains?: ReadonlyArray<string>;
  readonly afterCursor?: number;
  readonly waitSeconds?: number;
}

const ACTIVE_TASK_STATES: ReadonlySet<BackgroundTaskState> = new Set([
  "starting",
  "running",
  "stopping",
]);

export const isActiveTaskState = (state: BackgroundTaskState): boolean =>
  ACTIVE_TASK_STATES.has(state);

/**
 * Whether a finish sends a notice. A failure is a nonzero exit, a death by signal, a failed
 * start, or a timeout; a stop is not one.
 */
export const notifiesOn = (
  filter: BackgroundTaskNotifyFilter,
  task: Pick<BackgroundTaskSnapshot, "state">,
): boolean => filter === "exit" || task.state === "failed" || task.state === "timed_out";

export const failingExitCode = (
  task: Pick<BackgroundTaskSnapshot, "exitCode">,
): number | undefined =>
  task.exitCode === null || task.exitCode === undefined || task.exitCode === 0
    ? undefined
    : task.exitCode;

export const countTaskStates = (tasks: ReadonlyArray<Pick<BackgroundTaskSnapshot, "state">>) => {
  let active = 0;
  let failed = 0;
  for (const task of tasks) {
    if (isActiveTaskState(task.state)) active += 1;
    else if (task.state === "failed" || task.state === "timed_out") failed += 1;
  }
  return { active, failed };
};

export function sortTasksByActivity<A extends Pick<BackgroundTaskSnapshot, "state" | "startedAt">>(
  tasks: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return Arr.sort(
    tasks,
    Order.combine(
      Order.mapInput(Order.Boolean, (task: A) => !isActiveTaskState(task.state)),
      Order.mapInput(Order.flip(Order.Number), (task: A) => task.startedAt),
    ),
  );
}

export function footerStatus(projection: BackgroundTaskProjection): string | undefined {
  const { active } = countTaskStates(projection.tasks);
  if (active === 0) return undefined;
  return `${countLabel(active, "background task")} running`;
}

/** How much discarded output a read missed, such as "12 KiB" or "at least 12 KiB". */
export const skippedAmountText = (skipped: BackgroundOutputSkip): string =>
  `${skipped.atLeast ? "at least " : ""}${formatBytes(skipped.bytes)}`;
