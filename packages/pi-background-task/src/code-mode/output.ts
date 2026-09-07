import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { BackgroundTaskSnapshot, StartBackgroundTask } from "../task/model.ts";
import {
  backgroundTaskStartCommandResult,
  type BackgroundTaskCommandResult,
} from "../tools/command.ts";
import {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BackgroundTaskCodeModeOutputSchema,
  type BackgroundTaskCodeModeOutput,
} from "./protocol.ts";

const borrowOutput = (result: BackgroundTaskCommandResult): BackgroundTaskCodeModeOutput => {
  const details = result.details;
  if (details.action === "logs") {
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
  }
  return { text: result.text, ...details };
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
  // The service re-validates these bounds before admitting a start; refusing oversized request
  // fields here keeps that guarantee on the envelope path regardless of the exact byte measure.
  if (
    request.command.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars ||
    request.cwd.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars ||
    (request.name?.length ?? 0) > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars
  ) {
    return false;
  }
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

/** Shared provider and consumer aggregate bound, measured with exact serialized JSON size. */
export const backgroundTaskCodeModeOutputFits = (
  output: BackgroundTaskCodeModeOutput,
  maxOutputBytes: number,
): boolean => {
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0 ? maxOutputBytes : 0;
  try {
    return Buffer.byteLength(JSON.stringify(output)) <= limit;
  } catch {
    // Cyclic or non-JSON-representable hostile payloads are refused, never accepted.
    return false;
  }
};

/**
 * Recursively freezes a detached, acyclic, function-free decoded value, including nested payload
 * leaves such as `logs` metadata or `wait` snapshots.
 */
const deepFreeze = <T>(value: T): void => {
  if (Array.isArray(value)) {
    for (const child of value) deepFreeze(child);
  } else if (value !== null && value instanceof Object) {
    for (const child of Object.values(value)) deepFreeze(child);
  }
  // SAFETY: freezing a primitive leaf is a no-op; containers are schema-produced plain data.
  Object.freeze(value as object);
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
  if (!decoded) return { _tag: "Refused" };
  deepFreeze(decoded);
  return { _tag: "Accepted", output: decoded };
};
