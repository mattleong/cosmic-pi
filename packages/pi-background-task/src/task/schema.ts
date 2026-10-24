import * as Schema from "effect/Schema";
import { utf8ByteLength } from "pi-cosmic-core/text";
import {
  BACKGROUND_LOG_BOUNDS as LOG_BOUNDS,
  BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS,
} from "./bounds.ts";

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
export const BACKGROUND_TASK_NOTIFY_FILTERS = ["exit", "failure"] as const;
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
  // A display copy; the service runs the full command, which may be longer.
  command: MaxChars(BOUNDS.maxCommandDisplayChars),
  cwd: MaxChars(BOUNDS.maxCwdChars),
  state: BackgroundTaskStateSchema,
  pid: Schema.optionalKey(Schema.Natural.check(Schema.isGreaterThan(0))),
  startedAt: Schema.Natural,
  endedAt: Schema.optionalKey(Schema.Natural),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(MaxChars(BOUNDS.maxSignalChars)),
  error: Schema.optionalKey(MaxChars(BOUNDS.maxErrorChars)),
  // A short, credential-redacted output line naming why a failed task failed.
  failureCause: Schema.optionalKey(MaxChars(BOUNDS.maxErrorChars)),
  logCursor: Schema.Natural,
  droppedLogBytes: Schema.Natural,
});
const BackgroundTaskSnapshotsSchema = Schema.Array(BackgroundTaskSnapshotSchema).check(
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
  // The contains alternative found, and the plain output line around it.
  matchedText: Schema.optionalKey(MaxChars(BOUNDS.maxContainsChars)),
  matchedLine: Schema.optionalKey(MaxChars(BOUNDS.maxMatchedLineChars)),
  // The newest plain output when the wait returned, as logs shows it; absent without output.
  tail: Schema.optionalKey(
    Schema.String.check(
      Schema.isMaxLength(LOG_BOUNDS.recentOutputBytes),
      Schema.makeFilter((tail: string) => utf8ByteLength(tail) <= LOG_BOUNDS.recentOutputBytes, {
        expected: `at most ${LOG_BOUNDS.recentOutputBytes} UTF-8 bytes`,
      }),
    ),
  ),
});

export const AppliedWaitSecondsSchema = Schema.Finite.check(
  Schema.isBetween({ minimum: 0, maximum: BOUNDS.maxWaitSeconds }),
);

export const BackgroundTaskDetailsSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["start", "status"]),
    snapshot: BackgroundTaskSnapshotSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("stop"),
    snapshot: BackgroundTaskSnapshotSchema,
    // The task had already finished, so this call stopped nothing.
    alreadyFinished: Schema.Boolean,
  }),
  Schema.Struct({
    action: Schema.Literals(["list", "stop_all"]),
    tasks: BackgroundTaskSnapshotsSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    logs: BackgroundLogMetadataSchema,
    task: Schema.Struct({
      name: BackgroundTaskSnapshotSchema.fields.name,
      command: BackgroundTaskSnapshotSchema.fields.command,
    }),
    // Retained output this text leaves out; reading from resumeAfterCursor recovers it.
    truncation: Schema.optionalKey(
      Schema.Struct({
        omitted: Schema.Literals(["earlier", "later"]),
        omittedBytes: Schema.Natural,
        resumeAfterCursor: Schema.Natural,
        // Part of one event too large for the whole result; paging cannot show it.
        cutBytes: Schema.optionalKey(Schema.Natural),
      }),
    ),
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    wait: BackgroundTaskWaitResultSchema,
    appliedWaitSeconds: AppliedWaitSecondsSchema,
  }),
  Schema.Struct({ action: Schema.Literal("clear"), removed: Schema.Natural }),
]);
