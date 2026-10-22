import * as Schema from "effect/Schema";

export const BackgroundTaskConfigSchema = Schema.Struct({
  enabled: Schema.Boolean,
  maxRunning: Schema.Finite,
  maxRetained: Schema.Finite,
  logBufferBytesPerTask: Schema.Finite,
  totalLogBufferBytes: Schema.Finite,
  stopGraceMs: Schema.Finite,
  maxWaitSeconds: Schema.Finite,
  showFooterStatus: Schema.Boolean,
  shellPath: Schema.optionalKey(Schema.String),
});

export type BackgroundTaskConfig = typeof BackgroundTaskConfigSchema.Type;
export type BackgroundTaskSettingId = keyof BackgroundTaskConfig;
export type BackgroundTaskSettingValue<Id extends BackgroundTaskSettingId> =
  Required<BackgroundTaskConfig>[Id];

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
