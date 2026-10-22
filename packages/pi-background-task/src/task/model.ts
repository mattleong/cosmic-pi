import type {
  BackgroundLogMetadataSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskStateSchema,
  BackgroundTaskWaitResultSchema,
} from "./schema.ts";
import { countLabel, formatBytes } from "pi-cosmic-core";

export type BackgroundTaskState = typeof BackgroundTaskStateSchema.Type;
export type BackgroundTaskSnapshot = typeof BackgroundTaskSnapshotSchema.Type;
export type BackgroundTaskStatus = BackgroundTaskSnapshot & { readonly failureCause?: string };
export type BackgroundTaskStatusWait = Omit<BackgroundTaskWaitResult, "snapshot"> & {
  readonly snapshot: BackgroundTaskStatus;
  readonly appliedWaitSeconds: number;
};
export type BackgroundLogMetadata = typeof BackgroundLogMetadataSchema.Type;
export type BackgroundTaskWaitResult = typeof BackgroundTaskWaitResultSchema.Type;

export type BackgroundLogStream = "stdout" | "stderr";

export interface BackgroundLogEvent {
  readonly cursor: number;
  readonly stream: BackgroundLogStream;
  /** Normalized output: printable text, newlines, tabs, and complete SGR sequences only. */
  readonly text: string;
  readonly timestamp: number;
  readonly bytes: number;
  readonly droppedBefore?: true;
}

export interface BackgroundLogSlice extends BackgroundLogMetadata {
  readonly events: ReadonlyArray<BackgroundLogEvent>;
  /** Text bytes the task retains in total, including events outside this slice. */
  readonly retainedBytes: number;
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

export interface StartBackgroundTask {
  readonly command: string;
  readonly cwd: string;
  readonly name?: string;
  readonly timeoutSeconds?: number;
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
  readonly contains?: string;
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
  return tasks.toSorted((left, right) => {
    const active = Number(isActiveTaskState(right.state)) - Number(isActiveTaskState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function footerStatus(projection: BackgroundTaskProjection): string | undefined {
  const { active } = countTaskStates(projection.tasks);
  if (active === 0) return undefined;
  return `${countLabel(active, "background task")} running`;
}

export const discardedOutputText = (bytes: number): string =>
  `${formatBytes(bytes)} of earlier output was discarded`;
