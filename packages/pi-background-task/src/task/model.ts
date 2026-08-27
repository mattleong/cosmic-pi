export type BackgroundTaskState =
  | "starting"
  | "running"
  | "stopping"
  | "exited"
  | "failed"
  | "stopped"
  | "timed_out";

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

export interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: BackgroundTaskState;
  readonly pid?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number | null;
  readonly signal?: string;
  readonly error?: string;
  readonly logCursor: number;
  readonly droppedLogBytes: number;
}

export interface BackgroundLogSlice {
  readonly id: string;
  readonly events: ReadonlyArray<BackgroundLogEvent>;
  readonly nextCursor: number;
  readonly earliestAvailableCursor: number;
  readonly droppedBytes: number;
  readonly state: BackgroundTaskState;
}

export interface BackgroundTaskView extends BackgroundTaskSnapshot {
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

export type BackgroundTaskWaitUntil = "exit" | "output";
export type BackgroundTaskWaitOutcome = "matched" | "completed" | "timeout";

export interface WaitForBackgroundTask {
  readonly id: string;
  readonly until: BackgroundTaskWaitUntil;
  readonly contains?: string;
  readonly afterCursor?: number;
  readonly waitSeconds?: number;
}

export interface BackgroundTaskWaitResult {
  readonly id: string;
  readonly outcome: BackgroundTaskWaitOutcome;
  readonly snapshot: BackgroundTaskSnapshot;
  readonly nextCursor: number;
  readonly earliestAvailableCursor: number;
  readonly droppedBytes: number;
  readonly matchCursor?: number;
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

export const emptyProjection = (): BackgroundTaskProjection => ({ tasks: [] });

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
  const { active, failed } = countTaskStates(projection.tasks);
  if (active === 0 && failed === 0) return undefined;
  if (active === 0) return `${failed} background task${failed === 1 ? "" : "s"} failed`;
  return `${active} background task${active === 1 ? "" : "s"} active${failed > 0 ? ` · ${failed} failed` : ""}`;
}
