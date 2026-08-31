import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  BackgroundTaskSnapshot,
  BackgroundTaskWaitResult,
  StartBackgroundTask,
} from "../task/model.ts";
import {
  backgroundTaskStartCommandResult,
  type BackgroundTaskCommandResult,
} from "../tools/command.ts";
import { backgroundTaskCodeModeOutputFits } from "./output-size.ts";
import {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BackgroundTaskCodeModeOutputSchema,
  type BackgroundTaskCodeModeOutput,
} from "./protocol.ts";

const borrowOutput = (result: BackgroundTaskCommandResult): BackgroundTaskCodeModeOutput => {
  const details = result.details;
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return { action: details.action, text: result.text, snapshot: details.snapshot };
    case "list":
    case "stop_all":
      return { action: details.action, text: result.text, tasks: details.tasks };
    case "logs":
      return {
        action: details.action,
        text: result.text,
        logs: {
          id: details.logs.id,
          nextCursor: details.logs.nextCursor,
          earliestAvailableCursor: details.logs.earliestAvailableCursor,
          droppedBytes: details.logs.droppedBytes,
          state: details.logs.state,
        },
      };
    case "wait":
      return { action: details.action, text: result.text, wait: details.wait };
    case "clear":
      return { action: details.action, text: result.text, removed: details.removed };
  }
};

/**
 * Proves that any successful initial start snapshot fits before the service allocates a task id.
 * The envelope uses the normalized request plus worst-case generated id and spawn-success metadata,
 * including the terminal fields that can appear when a process exits before start returns.
 */
export const backgroundTaskCodeModeStartOutputFits = (
  request: StartBackgroundTask,
  maxTextBytes: number,
  maxOutputBytes: number,
): boolean => {
  const snapshot: BackgroundTaskSnapshot = {
    id: `task-${"9".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars - "task-".length)}`,
    ...(request.name && { name: request.name }),
    command: request.command,
    cwd: request.cwd,
    state: "timed_out",
    pid: Number.MAX_SAFE_INTEGER,
    startedAt: Number.MAX_SAFE_INTEGER,
    endedAt: Number.MAX_SAFE_INTEGER,
    exitCode: Number.MIN_SAFE_INTEGER,
    signal: "S".repeat(BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSignalChars),
    logCursor: Number.MAX_SAFE_INTEGER,
    droppedLogBytes: Number.MAX_SAFE_INTEGER,
  };
  return backgroundTaskCodeModeOutputFits(
    borrowOutput(backgroundTaskStartCommandResult(snapshot, maxTextBytes)),
    maxOutputBytes,
  );
};

const freezeSnapshot = (snapshot: BackgroundTaskSnapshot): void => {
  Object.freeze(snapshot);
};

const freezeWait = (wait: BackgroundTaskWaitResult): void => {
  freezeSnapshot(wait.snapshot);
  Object.freeze(wait);
};

const freezeOutput = (output: BackgroundTaskCodeModeOutput): BackgroundTaskCodeModeOutput => {
  switch (output.action) {
    case "start":
    case "status":
    case "stop":
      freezeSnapshot(output.snapshot);
      break;
    case "list":
    case "stop_all":
      for (const snapshot of output.tasks) freezeSnapshot(snapshot);
      Object.freeze(output.tasks);
      break;
    case "logs":
      Object.freeze(output.logs);
      break;
    case "wait":
      freezeWait(output.wait);
      break;
    case "clear":
      break;
  }
  return Object.freeze(output);
};

const decodeOutput = Schema.decodeUnknownOption(BackgroundTaskCodeModeOutputSchema);

export type BackgroundTaskCodeModeProjection =
  | { readonly _tag: "Accepted"; readonly output: BackgroundTaskCodeModeOutput }
  | { readonly _tag: "Refused" };

/** Refuses oversized output before schema decoding allocates the detached result. */
export const projectBackgroundTaskCodeModeOutput = (
  result: BackgroundTaskCommandResult,
  maxOutputBytes: number,
): BackgroundTaskCodeModeProjection => {
  const borrowed = borrowOutput(result);
  if (!backgroundTaskCodeModeOutputFits(borrowed, maxOutputBytes)) {
    return { _tag: "Refused" };
  }
  const decoded = Option.getOrUndefined(decodeOutput(borrowed));
  return decoded ? { _tag: "Accepted", output: freezeOutput(decoded) } : { _tag: "Refused" };
};
