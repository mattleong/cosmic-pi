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
  readonly revision: number;
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

export const ACTIVE_JOB_STATES: ReadonlySet<BackgroundJobState> = new Set([
  "starting",
  "running",
  "stopping",
]);

export const isActiveJobState = (state: BackgroundJobState): boolean =>
  ACTIVE_JOB_STATES.has(state);
