export interface BackgroundTaskConfig {
  readonly enabled: boolean;
  readonly maxRunning: number;
  readonly maxRetained: number;
  readonly logBufferBytesPerTask: number;
  readonly totalLogBufferBytes: number;
  readonly stopGraceMs: number;
  readonly maxWaitSeconds: number;
  readonly showFooterStatus: boolean;
  readonly shellPath?: string;
}

export const DEFAULT_BACKGROUND_TASK_CONFIG: BackgroundTaskConfig = {
  enabled: true,
  maxRunning: 8,
  maxRetained: 50,
  logBufferBytesPerTask: 256 * 1024,
  totalLogBufferBytes: 2 * 1024 * 1024,
  stopGraceMs: 2_000,
  maxWaitSeconds: 30,
  showFooterStatus: true,
};
