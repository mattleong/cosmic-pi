import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import type * as Path from "effect/Path";
import * as Str from "effect/String";
import { formatBytes } from "pi-cosmic-core/display";
import { utf8ByteLength } from "pi-cosmic-core/text";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "./bounds.ts";
import { InvalidBackgroundCommandError, InvalidBackgroundCwdError } from "./errors.ts";
import type { StartBackgroundTask, WaitForBackgroundTask } from "./model.ts";

const invalidCommand = (message: string) => InvalidBackgroundCommandError.make({ message });

const validTimeout = (timeoutSeconds: number | undefined) =>
  timeoutSeconds === undefined || (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0);

export const normalizeStartRequest = Effect.fn("BackgroundTaskAdmission.normalizeStartRequest")(
  function* (request: StartBackgroundTask, path: Path.Path) {
    // Whitespace can be shell syntax, such as an escaped trailing space, so the command runs as
    // submitted; trimming only detects a blank one.
    const command = request.command;
    if (!Str.trim(command)) return yield* invalidCommand("Background command must not be empty.");
    if (utf8ByteLength(command) > BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes)
      return yield* invalidCommand(
        `Background command must not exceed ${formatBytes(BACKGROUND_TASK_FIELD_BOUNDS.maxCommandBytes)} of UTF-8; write a longer script to a file and run that.`,
      );
    const name = request.name && Str.trim(request.name);
    if ((name?.length ?? 0) > BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars)
      return yield* invalidCommand(
        `Background task name must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars} characters.`,
      );
    if (!validTimeout(request.timeoutSeconds))
      return yield* invalidCommand(
        "Background timeout must be a positive finite number of seconds; omit it for no timeout.",
      );
    const cwd = path.resolve(request.cwd);
    if (cwd.length > BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars) {
      return yield* InvalidBackgroundCwdError.make({
        cwd,
        message: `Resolved background working directory must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars} characters.`,
      });
    }
    const prepared: StartBackgroundTask = {
      command,
      cwd,
      ...(name && { name }),
      ...(request.timeoutSeconds !== undefined && { timeoutSeconds: request.timeoutSeconds }),
      ...(request.notify !== undefined && { notify: request.notify }),
    };
    return prepared;
  },
);

const validCursor = (cursor: number | undefined) =>
  cursor === undefined || (Number.isInteger(cursor) && cursor >= 0);

const validAlternative = (text: string) =>
  text !== "" &&
  text.length <= BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars &&
  !Fn.pipe(text, Str.includes("\0"));

const validContains = (contains: ReadonlyArray<string> | undefined) =>
  contains !== undefined &&
  contains.length > 0 &&
  contains.length <= BACKGROUND_TASK_FIELD_BOUNDS.maxContainsAlternatives &&
  Arr.every(contains, validAlternative);

export const validateWaitRequest = Effect.fn("BackgroundTaskAdmission.validateWaitRequest")(
  function* (request: WaitForBackgroundTask, waitSeconds: number) {
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
      return yield* invalidCommand(
        "Background task wait must be a non-negative finite number of seconds.",
      );
    if (!validCursor(request.afterCursor))
      return yield* invalidCommand("Background task wait cursor must be a non-negative integer.");
    if (
      request.until === "exit" &&
      (request.contains !== undefined || request.afterCursor !== undefined)
    )
      return yield* invalidCommand(
        "contains and afterCursor are valid only when waiting for output.",
      );
    if (request.until === "output" && !validContains(request.contains))
      return yield* invalidCommand(
        `Output waits require contains: one text or up to ${BACKGROUND_TASK_FIELD_BOUNDS.maxContainsAlternatives} alternatives, each non-empty, at most ${BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars} characters, and with no NUL byte.`,
      );
    return undefined;
  },
);
