import * as Arr from "effect/Array";
import { BACKGROUND_TASK_FIELD_BOUNDS as BOUNDS } from "../task/bounds.ts";
import {
  isActiveTaskState,
  type BackgroundLogSlice,
  type BackgroundTaskState,
  type BackgroundTaskStatus,
  type BackgroundTaskStatusWait,
  type BackgroundTaskStopResult,
} from "../task/model.ts";
import { redactedLine } from "../task/redaction.ts";
import {
  BACKGROUND_TASK_CONTRACT_ID,
  BACKGROUND_TASK_CONTRACT_VERSION,
  BACKGROUND_TASK_TOOL_NAME,
  MAX_CONTRACT_CAUSE_CHARS,
  MAX_CONTRACT_LOG_OUTPUT_BYTES,
  type BackgroundTaskClearContract,
  type BackgroundTaskContractTask,
  type BackgroundTaskLogsContract,
  type BackgroundTaskStopContract,
  type BackgroundTaskTaskActionContract,
  type BackgroundTaskTasksActionContract,
  type BackgroundTaskWaitContract,
} from "./contract-schema.ts";
import { pageLogSlice, pageOmission } from "./log-page.ts";

const envelope = {
  contract: BACKGROUND_TASK_CONTRACT_ID,
  version: BACKGROUND_TASK_CONTRACT_VERSION,
  tool: BACKGROUND_TASK_TOOL_NAME,
} as const;

const isFinished = (state: BackgroundTaskState): boolean => !isActiveTaskState(state);

const projectTaskContract = (task: BackgroundTaskStatus): BackgroundTaskContractTask => {
  const name = redactedLine(task.name, BOUNDS.maxNameChars);
  const signal = redactedLine(task.signal, BOUNDS.maxSignalChars);
  const error = redactedLine(task.error, BOUNDS.maxErrorChars);
  const cause = redactedLine(task.failureCause, MAX_CONTRACT_CAUSE_CHARS);
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

export const stopContract = (stop: BackgroundTaskStopResult): BackgroundTaskStopContract => ({
  ...envelope,
  action: "stop",
  task: projectTaskContract(stop.snapshot),
  alreadyFinished: stop.alreadyFinished,
});

export const tasksActionContract = (
  action: BackgroundTaskTasksActionContract["action"],
  tasks: ReadonlyArray<BackgroundTaskStatus>,
): BackgroundTaskTasksActionContract => ({
  ...envelope,
  action,
  tasks: Arr.map(tasks, projectTaskContract),
});

/** Pages the slice independently of the text result, within the structured output bound. */
export const logsContract = (
  slice: BackgroundLogSlice,
  direction: "forward" | "tail",
): BackgroundTaskLogsContract => {
  const page = pageLogSlice(slice, direction, {
    maxBytes: MAX_CONTRACT_LOG_OUTPUT_BYTES,
    // Every line takes at least a byte, so only the byte bound applies.
    maxLines: MAX_CONTRACT_LOG_OUTPUT_BYTES + 1,
  });
  return {
    ...envelope,
    action: "logs",
    id: slice.id,
    state: slice.state,
    finished: isFinished(slice.state),
    output: page.output,
    truncated: pageOmission(slice, direction, page) !== undefined,
    nextCursor: page.nextCursor,
    earliestAvailableCursor: slice.earliestAvailableCursor,
    droppedBytes: slice.droppedBytes,
  };
};

export const waitContract = (
  wait: BackgroundTaskStatusWait,
  tail: string,
): BackgroundTaskWaitContract => ({
  ...envelope,
  action: "wait",
  outcome: wait.outcome,
  task: projectTaskContract(wait.snapshot),
  nextCursor: wait.nextCursor,
  earliestAvailableCursor: wait.earliestAvailableCursor,
  droppedBytes: wait.droppedBytes,
  ...(wait.matchCursor !== undefined && { matchCursor: wait.matchCursor }),
  ...(wait.matchedText !== undefined && { matchedText: wait.matchedText }),
  ...(wait.matchedLine !== undefined && { matchedLine: wait.matchedLine }),
  tail,
  appliedWaitSeconds: wait.appliedWaitSeconds,
});

export const clearContract = (removed: number): BackgroundTaskClearContract => ({
  ...envelope,
  action: "clear",
  removed,
});
