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

const metadata = (value: string | undefined, maximum: number): string | undefined => {
  const line = value === undefined ? "" : sanitizeTerminalLine(value);
  return line ? sanitizeDiagnosticError(line, { maximumLength: maximum }) : undefined;
};

const isFinished = (state: BackgroundTaskState): boolean => !isActiveTaskState(state);

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

export const combinedLogOutput = (events: ReadonlyArray<BackgroundLogEvent>): string =>
  stripTerminalControls(
    events.map((event) => `${event.stream === "stderr" ? "[stderr] " : ""}${event.text}`).join(""),
  );

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
