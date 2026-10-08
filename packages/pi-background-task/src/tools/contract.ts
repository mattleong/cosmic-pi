/**
 * Pure projections from task-service domain facts to the version-1 `background_task` contract.
 * Inputs are service snapshots with their domain-only failure cause, log slices, and wait
 * results, never persisted details or formatted text. Every field is picked explicitly, so the
 * command, cwd, pid, waiter marks, and log events cannot reach a contract, and free-form metadata
 * passes the core terminal and diagnostic redaction helpers. Task IDs are primary identity and
 * pass through unchanged.
 */
import {
  sanitizeDiagnosticError,
  sanitizeTerminalLine,
  stripTerminalControls,
  utf8Suffix,
} from "pi-cosmic-core";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "../task/bounds.ts";
import {
  isActiveTaskState,
  type BackgroundLogEvent,
  type BackgroundLogSlice,
  type BackgroundTaskState,
  type BackgroundTaskStatus,
  type BackgroundTaskStatusWait,
} from "../task/model.ts";
import {
  BACKGROUND_TASK_CONTRACT_ID,
  BACKGROUND_TASK_CONTRACT_VERSION,
  BACKGROUND_TASK_TOOL_NAME,
  MAX_CONTRACT_CAUSE_CHARS,
  MAX_CONTRACT_LOG_OUTPUT_BYTES,
  type BackgroundTaskClearContract,
  type BackgroundTaskContractTask,
  type BackgroundTaskLogsContract,
  type BackgroundTaskTaskActionContract,
  type BackgroundTaskTasksActionContract,
  type BackgroundTaskWaitContract,
} from "./contract-schema.ts";

const envelope = {
  contract: BACKGROUND_TASK_CONTRACT_ID,
  version: BACKGROUND_TASK_CONTRACT_VERSION,
  tool: BACKGROUND_TASK_TOOL_NAME,
} as const;

/** Redacted, single-line, bounded metadata; blank or control-only text is absent. */
const metadata = (value: string | undefined, maximum: number): string | undefined => {
  const line = value === undefined ? "" : sanitizeTerminalLine(value);
  return line ? sanitizeDiagnosticError(line, { maximumLength: maximum }) : undefined;
};

/**
 * The task state is terminal. Never proof that the process tree exited, was cleaned up, or
 * succeeded: failed, stopped, and timed-out tasks are finished too.
 */
const isFinished = (state: BackgroundTaskState): boolean => !isActiveTaskState(state);

/** One task's contract metadata, including the failure cause that persisted details omit. */
const projectTaskContract = (task: BackgroundTaskStatus): BackgroundTaskContractTask => {
  const name = metadata(task.name, BOUNDS.maxNameChars);
  const signal = metadata(task.signal, BOUNDS.maxSignalChars);
  const error = metadata(task.error, BOUNDS.maxErrorChars);
  const cause = metadata(task.failureCause, MAX_CONTRACT_CAUSE_CHARS);
  return {
    id: task.id,
    ...(name !== undefined && { name }),
    state: task.state,
    finished: isFinished(task.state),
    startedAt: task.startedAt,
    ...(task.endedAt !== undefined && { endedAt: task.endedAt }),
    ...(task.exitCode !== undefined && { exitCode: task.exitCode }),
    ...(signal !== undefined && { signal }),
    ...(error !== undefined && { error }),
    ...(cause !== undefined && { cause }),
    logCursor: task.logCursor,
    droppedLogBytes: task.droppedLogBytes,
  };
};

export const taskActionContract = (
  action: BackgroundTaskTaskActionContract["action"],
  task: BackgroundTaskStatus,
): BackgroundTaskTaskActionContract => ({ ...envelope, action, task: projectTaskContract(task) });

export const tasksActionContract = (
  action: BackgroundTaskTasksActionContract["action"],
  tasks: ReadonlyArray<BackgroundTaskStatus>,
): BackgroundTaskTasksActionContract => ({
  ...envelope,
  action,
  tasks: tasks.map(projectTaskContract),
});

/**
 * Sanitized combined stdout and stderr in retained order. A stderr chunk starts with `[stderr] `,
 * the convention the result text also uses. Terminal controls are removed; credentials are not.
 */
export const combinedLogOutput = (events: ReadonlyArray<BackgroundLogEvent>): string =>
  stripTerminalControls(
    events.map((event) => `${event.stream === "stderr" ? "[stderr] " : ""}${event.text}`).join(""),
  );

/**
 * Logs carry the newest bytes of `output`, independent of the result text's bounds. Clipping is
 * not paging: `nextCursor` stays the latest assigned cursor, so clipped bytes are not re-read.
 */
export const logsContract = (
  slice: BackgroundLogSlice,
  output: string,
): BackgroundTaskLogsContract => {
  const clipped = utf8Suffix(output, MAX_CONTRACT_LOG_OUTPUT_BYTES);
  return {
    ...envelope,
    action: "logs",
    id: slice.id,
    state: slice.state,
    finished: isFinished(slice.state),
    output: clipped,
    truncated: clipped.length < output.length,
    nextCursor: slice.nextCursor,
    earliestAvailableCursor: slice.earliestAvailableCursor,
    droppedBytes: slice.droppedBytes,
  };
};

export const waitContract = (wait: BackgroundTaskStatusWait): BackgroundTaskWaitContract => ({
  ...envelope,
  action: "wait",
  outcome: wait.outcome,
  task: projectTaskContract(wait.snapshot),
  nextCursor: wait.nextCursor,
  earliestAvailableCursor: wait.earliestAvailableCursor,
  droppedBytes: wait.droppedBytes,
  ...(wait.matchCursor !== undefined && { matchCursor: wait.matchCursor }),
});

export const clearContract = (removed: number): BackgroundTaskClearContract => ({
  ...envelope,
  action: "clear",
  removed,
});
