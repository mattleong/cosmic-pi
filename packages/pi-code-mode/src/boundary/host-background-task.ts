import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  backgroundTaskCodeModeOutputFits,
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskToolInput,
} from "pi-background-task/code-mode";
import { invokeHostCallback } from "pi-cosmic-core";
import { formatForeignRejection } from "../tools/format.ts";
import { toolError, type ToolError } from "./codemode-runtime.ts";

const MAX_BACKGROUND_TASK_TEXT_CHARS = 65_536;
const MAX_BACKGROUND_TASK_COMMAND_CHARS = 2_048;
const MAX_BACKGROUND_TASK_PATH_CHARS = 1_024;
const MAX_BACKGROUND_TASK_ERROR_CHARS = 2_048;
const MAX_BACKGROUND_TASK_SNAPSHOTS = 600;
const NonNegativeInteger = Schema.Natural;
const PositiveInteger = Schema.Natural.check(Schema.isGreaterThan(0));
const BackgroundTaskStateSchema = Schema.Literals([
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
  "stopped",
  "timed_out",
]);
const SnapshotSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  command: Schema.String.check(Schema.isMaxLength(MAX_BACKGROUND_TASK_COMMAND_CHARS)),
  cwd: Schema.String.check(Schema.isMaxLength(MAX_BACKGROUND_TASK_PATH_CHARS)),
  state: BackgroundTaskStateSchema,
  pid: Schema.optionalKey(PositiveInteger),
  startedAt: NonNegativeInteger,
  endedAt: Schema.optionalKey(NonNegativeInteger),
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  error: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(MAX_BACKGROUND_TASK_ERROR_CHARS)),
  ),
  logCursor: NonNegativeInteger,
  droppedLogBytes: NonNegativeInteger,
});
const LogMetadataSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  nextCursor: NonNegativeInteger,
  earliestAvailableCursor: NonNegativeInteger,
  droppedBytes: NonNegativeInteger,
  state: BackgroundTaskStateSchema,
});
const WaitSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  outcome: Schema.Literals(["matched", "completed", "timeout"]),
  snapshot: SnapshotSchema,
  nextCursor: NonNegativeInteger,
  earliestAvailableCursor: NonNegativeInteger,
  droppedBytes: NonNegativeInteger,
  matchCursor: Schema.optionalKey(NonNegativeInteger),
});
const BoundedText = Schema.String.check(Schema.isMaxLength(MAX_BACKGROUND_TASK_TEXT_CHARS));

/** Validating discriminated output contract shared by discovery and the foreign adapter. */
export const BackgroundTaskCodeModeOutputSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["start", "status", "stop"]),
    text: BoundedText,
    snapshot: SnapshotSchema,
  }),
  Schema.Struct({
    action: Schema.Literals(["list", "stop_all"]),
    text: BoundedText,
    tasks: Schema.Array(SnapshotSchema).check(Schema.isMaxLength(MAX_BACKGROUND_TASK_SNAPSHOTS)),
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    text: BoundedText,
    logs: LogMetadataSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    text: BoundedText,
    wait: WaitSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("clear"),
    text: BoundedText,
    removed: NonNegativeInteger,
  }),
]);

const decodeOutput = Schema.decodeUnknownEffect(BackgroundTaskCodeModeOutputSchema);
export type BackgroundTaskGuestOutput = typeof BackgroundTaskCodeModeOutputSchema.Encoded;

export interface BackgroundTaskDispatchOptions {
  readonly events: ExtensionAPI["events"];
  readonly sessionId: string | undefined;
  readonly toolCallId: string;
  /** Current per-call allowance, already capped by the Code Mode host. */
  readonly maxOutputBytes: () => number;
}

export type BackgroundTaskDispatch = (
  input: BackgroundTaskToolInput,
) => Effect.Effect<BackgroundTaskGuestOutput, ToolError>;

interface BackgroundTaskRejection {
  readonly _tag: "BackgroundTaskRejection";
  readonly rejection: unknown;
}

/** Queries and invokes only the explicit pi-background-task capability for this Pi session. */
export const makeBackgroundTaskDispatch = (
  options: BackgroundTaskDispatchOptions,
): BackgroundTaskDispatch => {
  let nestedCalls = 0;
  return (input) =>
    Effect.suspend(() => {
      const sessionId = options.sessionId;
      if (sessionId === undefined) {
        return Effect.fail(
          toolError(
            "Nested tool 'session.backgroundTask' is unavailable because this Pi session has no stable id.",
          ),
        );
      }
      const candidates: Array<
        NonNullable<ReturnType<typeof normalizeBackgroundTaskCodeModeCapability>>
      > = [];
      const emitted = invokeHostCallback(() => {
        options.events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
          version: BACKGROUND_TASK_CODE_MODE_VERSION,
          sessionId,
          respond: <Candidate>(candidate: Candidate) => {
            const normalized = normalizeBackgroundTaskCodeModeCapability(candidate);
            if (normalized?.sessionId === sessionId) candidates.push(normalized);
          },
        });
        return true;
      }, false);
      if (!emitted || candidates.length === 0) {
        return Effect.fail(
          toolError(
            "Nested tool 'session.backgroundTask' is unavailable. Load and activate pi-background-task for this session.",
          ),
        );
      }
      if (candidates.length !== 1) {
        return Effect.fail(
          toolError(
            "Nested tool 'session.backgroundTask' is unavailable because multiple background-task providers responded.",
          ),
        );
      }
      const capability = candidates[0]!;
      nestedCalls += 1;
      const callId = `${options.toolCallId}/session.backgroundTask/${nestedCalls}`;
      const maxOutputBytes = options.maxOutputBytes();
      return Effect.tryPromise({
        try: (signal) => capability.execute(callId, input, signal, maxOutputBytes),
        catch: (rejection): BackgroundTaskRejection => ({
          _tag: "BackgroundTaskRejection",
          rejection,
        }),
      }).pipe(
        Effect.mapError((error) =>
          toolError(
            `Nested tool 'session.backgroundTask' failed: ${formatForeignRejection(error.rejection)}`,
          ),
        ),
        Effect.flatMap((output) =>
          decodeOutput(output).pipe(
            Effect.mapError(() =>
              toolError(
                "Nested tool 'session.backgroundTask' returned an unrecognized result shape.",
              ),
            ),
            Effect.flatMap((decoded) =>
              backgroundTaskCodeModeOutputFits(decoded, maxOutputBytes)
                ? Effect.succeed(decoded)
                : Effect.fail(
                    toolError(
                      "Nested tool 'session.backgroundTask' returned output beyond the current child-output allowance.",
                    ),
                  ),
            ),
          ),
        ),
      );
    });
};
