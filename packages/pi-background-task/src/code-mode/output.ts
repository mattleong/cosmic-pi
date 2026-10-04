import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { freezeSnapshot, invokeHostCallback } from "pi-cosmic-core";
import type {
  BackgroundLogMetadata,
  BackgroundTaskSnapshot,
  StartBackgroundTask,
} from "../task/model.ts";
import {
  backgroundTaskStartCommandResult,
  type BackgroundTaskCommandResult,
} from "../tools/command.ts";
import {
  BACKGROUND_TASK_CODE_MODE_BOUNDS,
  BackgroundTaskCodeModeOutputSchema,
  type BackgroundTaskCodeModeOutput,
} from "./protocol.ts";

/**
 * Exactly the members the v1 output returns, since the byte-size check runs before decoding:
 * detail-only fields (log truncation, cause spans, the applied wait) never count against it.
 */
const borrowOutput = ({
  text,
  details,
}: BackgroundTaskCommandResult): BackgroundTaskCodeModeOutput => {
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return { action: details.action, text, snapshot: details.snapshot };
    case "list":
    case "stop_all":
      return { action: details.action, text, tasks: details.tasks };
    case "logs":
      return { action: details.action, text, logs: details.logs };
    case "wait":
      return { action: details.action, text, wait: details.wait };
    case "clear":
      return { action: details.action, text, removed: details.removed };
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
  // Cyclic or non-JSON-representable hostile payloads are refused, never accepted.
  return invokeHostCallback(() => Buffer.byteLength(JSON.stringify(output)) <= limit, false);
};

/**
 * Whether a `logs` result with `text` fits once encoded, envelope and JSON escapes included, so
 * the executor can keep the newest output that does.
 */
export const backgroundTaskCodeModeLogsOutputFits = (
  text: string,
  logs: BackgroundLogMetadata,
  maxOutputBytes: number,
): boolean =>
  backgroundTaskCodeModeOutputFits(
    borrowOutput({ text, details: { action: "logs", logs } }),
    maxOutputBytes,
  );

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
  return { _tag: "Accepted", output: freezeSnapshot(decoded) };
};
