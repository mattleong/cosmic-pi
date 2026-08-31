import { BACKGROUND_TASK_CODE_MODE_BOUNDS, type BackgroundTaskCodeModeOutput } from "./protocol.ts";

type BackgroundTaskCodeModeSnapshot = Extract<
  BackgroundTaskCodeModeOutput,
  { readonly snapshot: unknown }
>["snapshot"];
type BackgroundTaskCodeModeWait = Extract<
  BackgroundTaskCodeModeOutput,
  { readonly action: "wait" }
>["wait"];

const OUTPUT_FIXED_BYTES = 256;
const SNAPSHOT_FIXED_BYTES = 512;

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
const snapshotBytes = (snapshot: BackgroundTaskCodeModeSnapshot, limit: number): number => {
  if (
    snapshot.id.length === 0 ||
    snapshot.id.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars ||
    (snapshot.name?.length ?? 0) > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxNameChars ||
    snapshot.command.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxCommandChars ||
    snapshot.cwd.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxPathChars ||
    (snapshot.signal?.length ?? 0) > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSignalChars ||
    (snapshot.error?.length ?? 0) > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxErrorChars
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

const waitBytes = (wait: BackgroundTaskCodeModeWait, limit: number): number => {
  if (wait.id.length === 0 || wait.id.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars)
    return limit + 1;
  let bytes = snapshotBytes(wait.snapshot, limit);
  bytes = addString(bytes, wait.id, limit);
  bytes = addString(bytes, wait.outcome, limit);
  return bytes;
};

const outputBytes = (output: BackgroundTaskCodeModeOutput, limit: number): number => {
  if (output.text.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxTextChars) return limit + 1;
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
      if (output.tasks.length > BACKGROUND_TASK_CODE_MODE_BOUNDS.maxSnapshots) return limit + 1;
      for (const [index, snapshot] of output.tasks.entries()) {
        if (index > 0) bytes = addBounded(bytes, 1, limit);
        bytes = addBounded(bytes, snapshotBytes(snapshot, limit), limit);
        if (bytes > limit) return bytes;
      }
      return bytes;
    case "logs":
      return output.logs.id.length > 0 &&
        output.logs.id.length <= BACKGROUND_TASK_CODE_MODE_BOUNDS.maxIdChars
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
