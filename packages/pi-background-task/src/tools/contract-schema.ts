/**
 * Version-1 machine-readable `background_task` result contract for native Code Mode scripts. It
 * is separate from the persisted display details: it carries only projected domain facts, never
 * formatted text, and encodes strictly, so an unexpected key or out-of-bounds value is a producer
 * invariant failure rather than silently accepted data.
 */
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { freezeSnapshot, utf8ByteLength } from "pi-cosmic-core";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "../task/bounds.ts";
import {
  BackgroundLogMetadataSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskWaitResultSchema,
  MaxChars,
} from "../task/schema.ts";

export const BACKGROUND_TASK_CONTRACT_ID = "pi-background-task/task";
export const BACKGROUND_TASK_CONTRACT_VERSION = 1;
export const BACKGROUND_TASK_TOOL_NAME = "background_task";
/** Newest UTF-8 bytes of combined log output that one `logs` contract carries. */
export const MAX_CONTRACT_LOG_OUTPUT_BYTES = 1_048_576;
/** A failure cause is error-like metadata and shares the error bound. */
export const MAX_CONTRACT_CAUSE_CHARS = BOUNDS.maxErrorChars;

// The persisted member fields are reused as values; their schemas and order stay unchanged.
const snapshot = BackgroundTaskSnapshotSchema.fields;
const logs = BackgroundLogMetadataSchema.fields;
const wait = BackgroundTaskWaitResultSchema.fields;

const envelope = {
  contract: Schema.Literal(BACKGROUND_TASK_CONTRACT_ID),
  version: Schema.Literal(BACKGROUND_TASK_CONTRACT_VERSION),
  tool: Schema.Literal(BACKGROUND_TASK_TOOL_NAME),
};

const Finished = Schema.Boolean.annotate({
  description:
    "The task state is terminal. Not proof that the process tree exited, was cleaned up, or succeeded.",
});

/** One task's metadata. Command, cwd, pid, waiter marks, and log events are never projected. */
const TaskContractSchema = Schema.Struct({
  id: snapshot.id,
  name: snapshot.name,
  state: snapshot.state,
  finished: Finished,
  startedAt: snapshot.startedAt,
  endedAt: snapshot.endedAt,
  exitCode: snapshot.exitCode,
  signal: snapshot.signal,
  error: snapshot.error,
  cause: Schema.optionalKey(
    MaxChars(MAX_CONTRACT_CAUSE_CHARS).annotate({
      description: "The redacted output line that names why a failed task failed.",
    }),
  ),
  logCursor: snapshot.logCursor,
  droppedLogBytes: snapshot.droppedLogBytes,
});

// The UTF-16 length bound is the JSON Schema-visible form of the UTF-8 byte bound.
const LogOutput = Schema.String.annotate({
  description:
    "Newest sanitized stdout/stderr from the requested slice, at most 1 MiB of UTF-8. Stderr prefixes may be clipped. Not credential-redacted; defaults to the last 200 lines.",
}).check(
  Schema.isMaxLength(MAX_CONTRACT_LOG_OUTPUT_BYTES),
  Schema.makeFilter((output: string) => utf8ByteLength(output) <= MAX_CONTRACT_LOG_OUTPUT_BYTES, {
    expected: `at most ${MAX_CONTRACT_LOG_OUTPUT_BYTES} UTF-8 bytes`,
  }),
);

const TaskActionContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literals(["start", "status", "stop"]),
  task: TaskContractSchema,
});

const TasksActionContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literals(["list", "stop_all"]),
  tasks: Schema.Array(TaskContractSchema).check(Schema.isMaxLength(BOUNDS.maxSnapshots)),
});

const LogsContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literal("logs"),
  id: logs.id,
  state: logs.state,
  finished: Finished,
  output: LogOutput,
  truncated: Schema.Boolean.annotate({
    description:
      "Output was clipped to its newest bytes. Clipped bytes cannot be paged; droppedBytes counts buffer loss separately.",
  }),
  nextCursor: logs.nextCursor,
  earliestAvailableCursor: logs.earliestAvailableCursor,
  droppedBytes: logs.droppedBytes,
});

const WaitContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literal("wait"),
  outcome: wait.outcome.annotate({
    description: "A timeout is a normal result; it never stops the task.",
  }),
  task: TaskContractSchema,
  nextCursor: wait.nextCursor,
  earliestAvailableCursor: wait.earliestAvailableCursor,
  droppedBytes: wait.droppedBytes,
  matchCursor: wait.matchCursor,
});

const ClearContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literal("clear"),
  removed: Schema.Natural,
});

/** Success-only contract: typed failures reject the call and carry no contract. */
export const BackgroundTaskContractSchema = Schema.Union([
  TaskActionContractSchema,
  TasksActionContractSchema,
  LogsContractSchema,
  WaitContractSchema,
  ClearContractSchema,
]);

export type BackgroundTaskContract = typeof BackgroundTaskContractSchema.Type;
export type BackgroundTaskContractTask = typeof TaskContractSchema.Type;
export type BackgroundTaskTaskActionContract = typeof TaskActionContractSchema.Type;
export type BackgroundTaskTasksActionContract = typeof TasksActionContractSchema.Type;
export type BackgroundTaskLogsContract = typeof LogsContractSchema.Type;
export type BackgroundTaskWaitContract = typeof WaitContractSchema.Type;
export type BackgroundTaskClearContract = typeof ClearContractSchema.Type;

const STRICT_PARSE_OPTIONS = { errors: "first", onExcessProperty: "error" } as const;
const encodeContract = Schema.encodeExit(
  Schema.toCodecJson(BackgroundTaskContractSchema),
  STRICT_PARSE_OPTIONS,
);

/**
 * Strictly encodes one contract with the JSON codec the native `outputSchema` describes and
 * returns detached, deeply frozen `structuredContent`. A producer invariant failure returns
 * `undefined`, never a partial value.
 */
export const encodeBackgroundTaskContract = (
  contract: BackgroundTaskContract,
): Schema.Json | undefined => {
  try {
    const exit = encodeContract(contract);
    return Exit.isSuccess(exit) ? freezeSnapshot(exit.value) : undefined;
  } catch {
    return undefined;
  }
};
