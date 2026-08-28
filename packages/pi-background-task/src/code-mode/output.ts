import type { BackgroundTaskSnapshot, BackgroundTaskWaitResult } from "../task/model.ts";
import type { BackgroundTaskCommandResult } from "../tools/command.ts";
import type { BackgroundTaskCodeModeOutput } from "./protocol.ts";

const OUTPUT_FIXED_BYTES = 256;
const SNAPSHOT_FIXED_BYTES = 512;
const MAX_ID_CHARS = 256;
const MAX_NAME_CHARS = 256;
const MAX_COMMAND_CHARS = 2_048;
const MAX_PATH_CHARS = 1_024;
const MAX_SIGNAL_CHARS = 256;
const MAX_ERROR_CHARS = 2_048;

const addBounded = (current: number, added: number, limit: number): number =>
  current > limit || added > limit - current ? limit + 1 : current + added;

/** Exact UTF-8 byte count of a JSON-escaped string, including its quote characters. */
const jsonStringBytes = (value: string, limit: number): number => {
  let bytes = 2;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    const added =
      point === 0x22 ||
      point === 0x5c ||
      point === 0x08 ||
      point === 0x09 ||
      point === 0x0a ||
      point === 0x0c ||
      point === 0x0d
        ? 2
        : point <= 0x1f || (point >= 0xd800 && point <= 0xdfff)
          ? 6
          : point <= 0x7f
            ? 1
            : point <= 0x7ff
              ? 2
              : point <= 0xffff
                ? 3
                : 4;
    bytes = addBounded(bytes, added, limit);
    if (bytes > limit) return bytes;
  }
  return bytes;
};

const addString = (current: number, value: string | undefined, limit: number): number =>
  value === undefined ? current : addBounded(current, jsonStringBytes(value, limit), limit);

/**
 * Conservative JSON size bound for one snapshot. Fixed bytes cover keys, punctuation, nulls,
 * and every numeric rendering; string bytes use exact JSON escaping.
 */
const snapshotBytes = (snapshot: BackgroundTaskSnapshot, limit: number): number => {
  if (
    snapshot.id.length > MAX_ID_CHARS ||
    (snapshot.name?.length ?? 0) > MAX_NAME_CHARS ||
    snapshot.command.length > MAX_COMMAND_CHARS ||
    snapshot.cwd.length > MAX_PATH_CHARS ||
    (snapshot.signal?.length ?? 0) > MAX_SIGNAL_CHARS ||
    (snapshot.error?.length ?? 0) > MAX_ERROR_CHARS
  )
    return limit + 1;
  let bytes = SNAPSHOT_FIXED_BYTES;
  for (const value of [
    snapshot.id,
    snapshot.name,
    snapshot.command,
    snapshot.cwd,
    snapshot.state,
    snapshot.signal,
    snapshot.error,
  ]) {
    bytes = addString(bytes, value, limit);
    if (bytes > limit) return bytes;
  }
  return bytes;
};

const waitBytes = (wait: BackgroundTaskWaitResult, limit: number): number => {
  if (wait.id.length > MAX_ID_CHARS) return limit + 1;
  let bytes = snapshotBytes(wait.snapshot, limit);
  bytes = addString(bytes, wait.id, limit);
  bytes = addString(bytes, wait.outcome, limit);
  return bytes;
};

const outputBytes = (output: BackgroundTaskCodeModeOutput, limit: number): number => {
  let bytes = addString(OUTPUT_FIXED_BYTES, output.action, limit);
  bytes = addString(bytes, output.text, limit);
  if (bytes > limit) return bytes;
  switch (output.action) {
    case "start":
    case "status":
    case "stop":
      return addBounded(bytes, snapshotBytes(output.snapshot, limit), limit);
    case "list":
    case "stop_all":
      for (const [index, snapshot] of output.tasks.entries()) {
        if (index > 0) bytes = addBounded(bytes, 1, limit);
        bytes = addBounded(bytes, snapshotBytes(snapshot, limit), limit);
        if (bytes > limit) return bytes;
      }
      return bytes;
    case "logs":
      return output.logs.id.length <= MAX_ID_CHARS
        ? addString(bytes, output.logs.id, limit)
        : limit + 1;
    case "wait":
      return addBounded(bytes, waitBytes(output.wait, limit), limit);
    case "clear":
      return bytes;
  }
};

/** Shared provider and consumer aggregate bound, evaluated without compact JSON allocation. */
export const backgroundTaskCodeModeOutputFits = (
  output: BackgroundTaskCodeModeOutput,
  maxOutputBytes: number,
): boolean => {
  const limit = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes >= 0 ? maxOutputBytes : 0;
  return outputBytes(output, limit) <= limit;
};

const borrowOutput = (
  result: BackgroundTaskCommandResult,
): BackgroundTaskCodeModeOutput | undefined => {
  const details = result.details;
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return details.snapshot
        ? { action: details.action, text: result.text, snapshot: details.snapshot }
        : undefined;
    case "list":
    case "stop_all":
      return details.tasks
        ? { action: details.action, text: result.text, tasks: details.tasks }
        : undefined;
    case "logs":
      return details.logs
        ? {
            action: details.action,
            text: result.text,
            logs: {
              id: details.logs.id,
              nextCursor: details.logs.nextCursor,
              earliestAvailableCursor: details.logs.earliestAvailableCursor,
              droppedBytes: details.logs.droppedBytes,
              state: details.logs.state,
            },
          }
        : undefined;
    case "wait":
      return details.wait
        ? { action: details.action, text: result.text, wait: details.wait }
        : undefined;
    case "clear":
      return details.removed === undefined
        ? undefined
        : { action: details.action, text: result.text, removed: details.removed };
  }
};

const copySnapshot = (snapshot: BackgroundTaskSnapshot): BackgroundTaskSnapshot =>
  Object.freeze({ ...snapshot });

const copyWait = (wait: BackgroundTaskWaitResult): BackgroundTaskWaitResult =>
  Object.freeze({ ...wait, snapshot: copySnapshot(wait.snapshot) });

const copyOutput = (output: BackgroundTaskCodeModeOutput): BackgroundTaskCodeModeOutput => {
  switch (output.action) {
    case "start":
    case "status":
    case "stop":
      return Object.freeze({ ...output, snapshot: copySnapshot(output.snapshot) });
    case "list":
    case "stop_all":
      return Object.freeze({
        ...output,
        tasks: Object.freeze(output.tasks.map(copySnapshot)),
      });
    case "logs":
      return Object.freeze({ ...output, logs: Object.freeze({ ...output.logs }) });
    case "wait":
      return Object.freeze({ ...output, wait: copyWait(output.wait) });
    case "clear":
      return Object.freeze({ ...output });
  }
};

export type BackgroundTaskCodeModeProjection =
  | { readonly _tag: "Accepted"; readonly output: BackgroundTaskCodeModeOutput }
  | { readonly _tag: "Refused" };

/** Refuses oversized output before copying snapshots or allocating a compact JSON string. */
export const projectBackgroundTaskCodeModeOutput = (
  result: BackgroundTaskCommandResult,
  maxOutputBytes: number,
): BackgroundTaskCodeModeProjection => {
  const borrowed = borrowOutput(result);
  if (!borrowed || !backgroundTaskCodeModeOutputFits(borrowed, maxOutputBytes)) {
    return { _tag: "Refused" };
  }
  return { _tag: "Accepted", output: copyOutput(borrowed) };
};
