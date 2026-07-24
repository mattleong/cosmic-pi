import * as Schema from "effect/Schema";

export interface BackgroundTerminalConfig {
  readonly enabled: boolean;
  readonly maxRunning: number;
  readonly maxRetained: number;
  readonly logBufferBytesPerJob: number;
  readonly totalLogBufferBytes: number;
  readonly stopGraceMs: number;
  readonly maxLogWaitSeconds: number;
  readonly showFooterStatus: boolean;
  readonly shellPath?: string;
}

export const DEFAULT_BACKGROUND_TERMINAL_CONFIG: BackgroundTerminalConfig = {
  enabled: true,
  maxRunning: 8,
  maxRetained: 50,
  logBufferBytesPerJob: 256 * 1024,
  totalLogBufferBytes: 2 * 1024 * 1024,
  stopGraceMs: 2_000,
  maxLogWaitSeconds: 30,
  showFooterStatus: true,
};

export const FiniteNumberSchema = Schema.Number.check(Schema.isFinite());
