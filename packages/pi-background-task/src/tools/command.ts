import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  sanitizeTerminalLine,
  stripTerminalControls as sanitizeTerminalText,
} from "pi-cosmic-core";
import { InvalidBackgroundCommandError } from "../task/errors.ts";
import type {
  BackgroundLogSlice,
  BackgroundTaskSnapshot,
  BackgroundTaskWaitResult,
  StartBackgroundTask,
} from "../task/model.ts";
import type { BackgroundTaskDetailsSchema } from "../task/schema.ts";
import { BackgroundTaskService } from "../task/service.ts";
import { utf8ByteLength } from "../task/utf8.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";

export type BackgroundTaskToolDetails = typeof BackgroundTaskDetailsSchema.Type;

export interface BackgroundTaskCommandResult {
  readonly text: string;
  readonly details: BackgroundTaskToolDetails;
}

const required = (
  value: string | undefined,
  field: string,
): Effect.Effect<string, InvalidBackgroundCommandError> =>
  value?.trim()
    ? Effect.succeed(value.trim())
    : new InvalidBackgroundCommandError({
        message: `${field} is required for this background_task action.`,
      });

const MAX_TASK_LINE_CHARS = 8_192;

export const formatBackgroundTask = (task: BackgroundTaskSnapshot): string => {
  const suffix = task.exitCode === undefined ? "" : ` code=${task.exitCode ?? "null"}`;
  return truncateLine(
    sanitizeTerminalLine(
      `${task.id}${task.name ? ` ${task.name}` : ""} ${task.state}${suffix} — ${task.command}`,
    ),
    MAX_TASK_LINE_CHARS,
  ).text;
};

const boundedText = (text: string, maxBytes: number): string =>
  truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes }).content;

const formatTaskList = (tasks: ReadonlyArray<BackgroundTaskSnapshot>, maxBytes: number): string => {
  if (tasks.length === 0) return boundedText("No background tasks.", maxBytes);
  const lines: string[] = [];
  let used = 0;
  for (const [index, task] of tasks.entries()) {
    const separatorBytes = lines.length === 0 ? 0 : 1;
    const line = formatBackgroundTask(task);
    const lineBytes = utf8ByteLength(line);
    const omittedAfter = tasks.length - index - 1;
    const markerAfter = `[${omittedAfter} background task${omittedAfter === 1 ? "" : "s"} omitted]`;
    const reservedMarkerBytes = omittedAfter > 0 ? 1 + utf8ByteLength(markerAfter) : 0;
    if (used + separatorBytes + lineBytes + reservedMarkerBytes > maxBytes) {
      const omitted = tasks.length - index;
      const marker = `[${omitted} background task${omitted === 1 ? "" : "s"} omitted]`;
      const markerBytes = utf8ByteLength(marker);
      if (used + separatorBytes + markerBytes <= maxBytes) lines.push(marker);
      break;
    }
    lines.push(line);
    used += separatorBytes + lineBytes;
  }
  return lines.join("\n");
};

const formatWait = (result: BackgroundTaskWaitResult): string => {
  const cursor = result.matchCursor ?? result.nextCursor;
  return sanitizeTerminalLine(
    `${result.id} ${result.outcome} state=${result.snapshot.state} cursor=${cursor}`,
  );
};

const formatLogs = (slice: BackgroundLogSlice, maxBytes: number) => {
  const content = sanitizeTerminalText(
    slice.events
      .map((event) => `${event.stream === "stderr" ? "[stderr] " : ""}${event.text}`)
      .join(""),
  );
  const cut = truncateTail(content, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  const { truncated, outputBytes, totalBytes, outputLines, totalLines } = cut;
  const metadata = `[${slice.id} state=${slice.state} cursor=${slice.nextCursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const gap = slice.droppedBytes > 0 ? `[${slice.droppedBytes} earlier log bytes discarded]\n` : "";
  return {
    text: `${metadata}${gap}${cut.content || "(no new output)"}`,
    // Five explicit fields: persisted details never store the truncated log text a second time.
    truncation: truncated
      ? { truncated, outputBytes, totalBytes, outputLines, totalLines }
      : undefined,
  };
};

const reply = (text: string, details: BackgroundTaskToolDetails): BackgroundTaskCommandResult => ({
  text,
  details,
});

/** The exact successful-start formatter used by execution and Code Mode admission. */
export const backgroundTaskStartCommandResult = (
  snapshot: BackgroundTaskSnapshot,
  maxTextBytes: number,
): BackgroundTaskCommandResult =>
  reply(boundedText(`Started ${formatBackgroundTask(snapshot)}`, maxTextBytes), {
    action: "start",
    snapshot,
  });

export interface BackgroundTaskCommandOptions {
  readonly maxTextBytes?: number;
  /** Optional nested-call barrier, evaluated after exact start normalization and before service.start. */
  readonly startOutputFits?: (request: StartBackgroundTask, maxTextBytes: number) => boolean;
}

/** Shared action executor used by the top-level Pi tool and the explicit Code Mode adapter. */
export const executeBackgroundTaskCommand = (
  input: BackgroundTaskToolInput,
  sessionCwd: string,
  options: BackgroundTaskCommandOptions = {},
) =>
  Effect.gen(function* () {
    const maxTextBytes = Math.max(
      0,
      Math.min(DEFAULT_MAX_BYTES, options.maxTextBytes ?? DEFAULT_MAX_BYTES),
    );
    const service = yield* BackgroundTaskService;
    const path = yield* Path.Path;
    switch (input.action) {
      case "start": {
        const name = input.name?.trim();
        const request: StartBackgroundTask = {
          command: yield* required(input.command, "command"),
          cwd: path.resolve(sessionCwd, input.cwd ?? "."),
          ...(name && { name }),
          ...(input.timeoutSeconds !== undefined && {
            timeoutSeconds: input.timeoutSeconds,
          }),
        };
        if (options.startOutputFits && !options.startOutputFits(request, maxTextBytes)) {
          return yield* new InvalidBackgroundCommandError({
            message:
              "Background task result exceeds the current Code Mode child-output allowance. " +
              "Use a shorter command, name, or cwd and retry.",
          });
        }
        const snapshot = yield* service.start(request);
        return backgroundTaskStartCommandResult(snapshot, maxTextBytes);
      }
      case "list": {
        const tasks = yield* service.list(input.state ?? "all");
        return reply(formatTaskList(tasks, maxTextBytes), { action: input.action, tasks });
      }
      case "status": {
        const snapshot = yield* service.status(yield* required(input.id, "id"));
        return reply(boundedText(formatBackgroundTask(snapshot), maxTextBytes), {
          action: input.action,
          snapshot,
        });
      }
      case "logs": {
        const slice = yield* service.logs({
          id: yield* required(input.id, "id"),
          ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
          ...(input.tailLines !== undefined && { tailLines: input.tailLines }),
          ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
        });
        const { text, truncation } = formatLogs(slice, maxTextBytes);
        const { events: _events, ...logs } = slice;
        return reply(boundedText(text, maxTextBytes), {
          action: input.action,
          logs,
          ...(truncation && { truncation }),
        });
      }
      case "wait": {
        if (input.until === undefined) {
          return yield* new InvalidBackgroundCommandError({
            message: "until is required for the background_task wait action.",
          });
        }
        const wait = yield* service.wait({
          id: yield* required(input.id, "id"),
          until: input.until,
          ...(input.contains !== undefined && { contains: input.contains }),
          ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
          ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
        });
        return reply(boundedText(formatWait(wait), maxTextBytes), {
          action: input.action,
          wait,
        });
      }
      case "stop": {
        const snapshot = yield* service.stop(yield* required(input.id, "id"), input.force);
        return reply(boundedText(`Stopped ${formatBackgroundTask(snapshot)}`, maxTextBytes), {
          action: input.action,
          snapshot,
        });
      }
      case "stop_all": {
        const tasks = yield* service.stopAll(input.force);
        return reply(
          boundedText(
            `Stopped ${tasks.length} background task${tasks.length === 1 ? "" : "s"}.`,
            maxTextBytes,
          ),
          { action: input.action, tasks },
        );
      }
      case "clear": {
        const removed = yield* service.clear;
        return reply(
          boundedText(
            `Cleared ${removed} completed background task${removed === 1 ? "" : "s"}.`,
            maxTextBytes,
          ),
          { action: input.action, removed },
        );
      }
    }
  });
