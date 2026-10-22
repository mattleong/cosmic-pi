import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { freezeSnapshot, utf8ByteLength } from "pi-cosmic-core";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "../task/bounds.ts";
import {
  AppliedWaitSecondsSchema,
  BackgroundLogMetadataSchema,
  BackgroundTaskSnapshotSchema,
  BackgroundTaskWaitResultSchema,
  MaxChars,
} from "../task/schema.ts";

export const BACKGROUND_TASK_CONTRACT_ID = "pi-background-task/task";
export const BACKGROUND_TASK_CONTRACT_VERSION = 1;
export const BACKGROUND_TASK_TOOL_NAME = "background_task";
export const MAX_CONTRACT_LOG_OUTPUT_BYTES = 1_048_576;
export const MAX_CONTRACT_CAUSE_CHARS = BOUNDS.maxErrorChars;

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

const LogOutput = Schema.String.annotate({
  description:
    "Sanitized plain stdout/stderr, at most 1 MiB of UTF-8, with each stderr line prefixed `[stderr] `. Not credential-redacted. Without afterCursor it holds the newest output, by default the last 200 lines.",
}).check(
  Schema.isMaxLength(MAX_CONTRACT_LOG_OUTPUT_BYTES),
  Schema.makeFilter((output: string) => utf8ByteLength(output) <= MAX_CONTRACT_LOG_OUTPUT_BYTES, {
    expected: `at most ${MAX_CONTRACT_LOG_OUTPUT_BYTES} UTF-8 bytes`,
  }),
);

const TaskActionContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literals(["start", "status"]),
  task: TaskContractSchema,
});

const StopContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literal("stop"),
  task: TaskContractSchema,
  alreadyFinished: Schema.Boolean.annotate({
    description: "The task had already finished, so this call stopped nothing.",
  }),
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
      "Retained output was left out, as the text result reports. After an afterCursor read, more output follows: read on from nextCursor. A read without afterCursor shows the newest output, by line limit or size, and earlier output is readable from earliestAvailableCursor.",
  }),
  nextCursor: logs.nextCursor.annotate({
    description: "Pass as afterCursor to read the output that follows this result.",
  }),
  earliestAvailableCursor: logs.earliestAvailableCursor.annotate({
    description: "Pass as afterCursor to read from the oldest retained output.",
  }),
  droppedBytes: logs.droppedBytes.annotate({
    description: "Output the task's log buffer already discarded; it cannot be read again.",
  }),
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
  appliedWaitSeconds: AppliedWaitSecondsSchema.annotate({
    description:
      "The longest this call would wait: waitSeconds capped by the maxWaitSeconds setting, which is also the default. After a timeout, call wait again.",
  }),
});

const ClearContractSchema = Schema.Struct({
  ...envelope,
  action: Schema.Literal("clear"),
  removed: Schema.Natural,
});

export const BackgroundTaskContractSchema = Schema.Union([
  TaskActionContractSchema,
  StopContractSchema,
  TasksActionContractSchema,
  LogsContractSchema,
  WaitContractSchema,
  ClearContractSchema,
]);

export type BackgroundTaskContract = typeof BackgroundTaskContractSchema.Type;
export type BackgroundTaskContractTask = typeof TaskContractSchema.Type;
export type BackgroundTaskTaskActionContract = typeof TaskActionContractSchema.Type;
export type BackgroundTaskStopContract = typeof StopContractSchema.Type;
export type BackgroundTaskTasksActionContract = typeof TasksActionContractSchema.Type;
export type BackgroundTaskLogsContract = typeof LogsContractSchema.Type;
export type BackgroundTaskWaitContract = typeof WaitContractSchema.Type;
export type BackgroundTaskClearContract = typeof ClearContractSchema.Type;

const STRICT_PARSE_OPTIONS = { errors: "first", onExcessProperty: "error" } as const;
const encodeContract = Schema.encodeExit(
  Schema.toCodecJson(BackgroundTaskContractSchema),
  STRICT_PARSE_OPTIONS,
);

/** Encoding failures, including defects the encoder raises, come back as a failed `Exit`. */
export const encodeBackgroundTaskContract = (
  contract: BackgroundTaskContract,
): Schema.Json | undefined => {
  const exit = encodeContract(contract);
  return Exit.isSuccess(exit) ? freezeSnapshot(exit.value) : undefined;
};
