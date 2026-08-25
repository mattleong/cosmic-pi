export type BackgroundJobState =
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
}

export interface BackgroundJobSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly cwd: string;
  readonly state: BackgroundJobState;
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
  readonly state: BackgroundJobState;
}

export interface BackgroundJobView extends BackgroundJobSnapshot {
  readonly logs: ReadonlyArray<BackgroundLogEvent>;
}

export interface BackgroundTerminalProjection {
  readonly jobs: ReadonlyArray<BackgroundJobView>;
}

export interface StartBackgroundJob {
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

const ACTIVE_JOB_STATES: ReadonlySet<BackgroundJobState> = new Set([
  "starting",
  "running",
  "stopping",
]);

export const isActiveJobState = (state: BackgroundJobState): boolean =>
  ACTIVE_JOB_STATES.has(state);

export interface BackgroundJobStateCounts {
  readonly active: number;
  readonly failed: number;
}

/** Single owner of the failed policy: `failed` counts both `failed` and `timed_out` jobs. */
export const countJobStates = (
  jobs: ReadonlyArray<Pick<BackgroundJobSnapshot, "state">>,
): BackgroundJobStateCounts => {
  let active = 0;
  let failed = 0;
  for (const job of jobs) {
    if (isActiveJobState(job.state)) active += 1;
    else if (job.state === "failed" || job.state === "timed_out") failed += 1;
  }
  return { active, failed };
};

export const emptyProjection = (): BackgroundTerminalProjection => ({ jobs: [] });

/** Active jobs first, then most recently started. Shared by snapshot and view ordering. */
export function sortJobsByActivity<A extends Pick<BackgroundJobSnapshot, "state" | "startedAt">>(
  jobs: ReadonlyArray<A>,
): ReadonlyArray<A> {
  return [...jobs].sort((left, right) => {
    const active = Number(isActiveJobState(right.state)) - Number(isActiveJobState(left.state));
    return active !== 0 ? active : right.startedAt - left.startedAt;
  });
}

export function footerStatus(projection: BackgroundTerminalProjection): string | undefined {
  const { active, failed } = countJobStates(projection.jobs);
  if (active === 0 && failed === 0) return undefined;
  if (active === 0) return `${failed} background job${failed === 1 ? "" : "s"} failed`;
  return `${active} background job${active === 1 ? "" : "s"} active${failed > 0 ? ` · ${failed} failed` : ""}`;
}
