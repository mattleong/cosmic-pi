import * as Schema from "effect/Schema";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "./bounds.ts";

/*
 * Pure owner of the task contract. The shared member schemas are part of the frozen v1 Code Mode
 * output contract: their field and literal order drives guest output key order, the model-facing
 * catalog, and compact counter order. Domain-only fields are intersected locally in `model.ts`.
 */

export const BACKGROUND_TASK_ACTIONS = [
  "start",
  "list",
  "status",
  "logs",
  "wait",
  "stop",
  "stop_all",
  "clear",
] as const;
export const BACKGROUND_TASK_STATES = [
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
  "stopped",
  "timed_out",
] as const;

export const MaxChars = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));
const TaskId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(BOUNDS.maxIdChars));

export const BackgroundTaskStateSchema = Schema.Literals(BACKGROUND_TASK_STATES);
export const BackgroundTaskSnapshotSchema = Schema.Struct({
  id: TaskId,
  name: Schema.optionalKey(MaxChars(BOUNDS.maxNameChars)),
  command: MaxChars(BOUNDS.maxCommandChars),
  cwd: MaxChars(BOUNDS.maxCwdChars),
  state: BackgroundTaskStateSchema,
  pid: Schema.optionalKey(Schema.Natural.check(Schema.isGreaterThan(0))),
  startedAt: Schema.Natural,
  endedAt: Schema.optionalKey(Schema.Natural),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(MaxChars(BOUNDS.maxSignalChars)),
  error: Schema.optionalKey(MaxChars(BOUNDS.maxErrorChars)),
  logCursor: Schema.Natural,
  droppedLogBytes: Schema.Natural,
});
export const BackgroundTaskSnapshotsSchema = Schema.Array(BackgroundTaskSnapshotSchema).check(
  Schema.isMaxLength(BOUNDS.maxSnapshots),
);
export const BackgroundLogMetadataSchema = Schema.Struct({
  id: TaskId,
  nextCursor: Schema.Natural,
  earliestAvailableCursor: Schema.Natural,
  droppedBytes: Schema.Natural,
  state: BackgroundTaskStateSchema,
});
export const BackgroundTaskWaitResultSchema = Schema.Struct({
  id: TaskId,
  outcome: Schema.Literals(["matched", "completed", "timeout"]),
  snapshot: BackgroundTaskSnapshotSchema,
  nextCursor: Schema.Natural,
  earliestAvailableCursor: Schema.Natural,
  droppedBytes: Schema.Natural,
  matchCursor: Schema.optionalKey(Schema.Natural),
});

/**
 * Where a failed task's cause appears in the result text: producer-computed UTF-16 offsets,
 * never parsed. Details stay metadata only; the cause itself lives in the text.
 */
const CauseSpans = Schema.optionalKey(
  Schema.Array(Schema.Struct({ id: TaskId, start: Schema.Natural, end: Schema.Natural })).check(
    Schema.isMaxLength(BOUNDS.maxSnapshots),
  ),
);

/**
 * Persisted `background_task` result details: metadata only, never command output. Older `logs`
 * details also carried `events: []` and Pi's full TruncationResult; decoding ignores those extras.
 */
export const BackgroundTaskDetailsSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["start", "status", "stop"]),
    snapshot: BackgroundTaskSnapshotSchema,
    causes: CauseSpans,
  }),
  Schema.Struct({
    action: Schema.Literals(["list", "stop_all"]),
    tasks: BackgroundTaskSnapshotsSchema,
    causes: CauseSpans,
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    logs: BackgroundLogMetadataSchema,
    truncation: Schema.optionalKey(
      Schema.Struct({
        truncated: Schema.Boolean,
        outputBytes: Schema.Natural,
        totalBytes: Schema.Natural,
        outputLines: Schema.Natural,
        totalLines: Schema.Natural,
      }),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    wait: BackgroundTaskWaitResultSchema,
    // Beside the frozen wait member, so the v1 Code Mode output never carries it.
    appliedWaitSeconds: Schema.optionalKey(
      Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: BOUNDS.maxWaitSeconds })),
    ),
    causes: CauseSpans,
  }),
  Schema.Struct({ action: Schema.Literal("clear"), removed: Schema.Natural }),
]);
