import type {
  BackgroundLogMetadataSchema,
  BackgroundTaskDetailsSnapshotSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskStateSchema,
  BackgroundTaskWaitResultSchema,
} from "./schema.ts";

export type BackgroundTaskState = typeof BackgroundTaskStateSchema.Type;
export type BackgroundTaskSnapshot = typeof BackgroundTaskSnapshotSchema.Type;
/** The service's snapshot: the v1 member plus the details-only `failureLine`. */
export type BackgroundTaskDetailsSnapshot = typeof BackgroundTaskDetailsSnapshotSchema.Type;
export type BackgroundLogMetadata = typeof BackgroundLogMetadataSchema.Type;
export type BackgroundTaskWaitResult = typeof BackgroundTaskWaitResultSchema.Type;

export type BackgroundLogStream = "stdout" | "stderr";

export interface BackgroundLogEvent {
  readonly cursor: number;
  readonly stream: BackgroundLogStream;
  readonly text: string;
  readonly timestamp: number;
  readonly bytes: number;
  /** True when bytes immediately before this retained chunk were discarded. */
  readonly droppedBefore?: true;
}

export interface BackgroundLogSlice extends BackgroundLogMetadata {
  readonly events: ReadonlyArray<BackgroundLogEvent>;
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

export interface BackgroundTaskStateCounts {
  readonly active: number;
  readonly failed: number;
}

/** Single owner of the failed policy: `failed` counts both `failed` and `timed_out` tasks. */
export const countTaskStates = (
  tasks: ReadonlyArray<Pick<BackgroundTaskSnapshot, "state">>,
): BackgroundTaskStateCounts => {
  let active = 0;
  let failed = 0;
  for (const task of tasks) {
    if (isActiveTaskState(task.state)) active += 1;
    else if (task.state === "failed" || task.state === "timed_out") failed += 1;
  }
  return { active, failed };
};

/** Active tasks first, then most recently started. Shared by snapshot and view ordering. */
export function sortTasksByActivity<A extends Pick<BackgroundTaskSnapshot, "state" | "startedAt">>(
  tasks: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return [...tasks].sort((left, right) => {
    const active = Number(isActiveTaskState(right.state)) - Number(isActiveTaskState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function footerStatus(projection: BackgroundTaskProjection): string | undefined {
  const { active } = countTaskStates(projection.tasks);
  if (active === 0) return undefined;
  return `${active} background task${active === 1 ? "" : "s"} active`;
}
