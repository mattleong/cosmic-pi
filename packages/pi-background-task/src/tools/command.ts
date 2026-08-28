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
} from "../task/model.ts";
import { BackgroundTaskService } from "../task/service.ts";
import { utf8ByteLength } from "../task/utf8.ts";
import type { BackgroundTaskAction, BackgroundTaskToolInput } from "./schema.ts";

export interface BackgroundTaskToolDetails {
  readonly action: BackgroundTaskAction;
  readonly snapshot?: BackgroundTaskSnapshot;
  readonly tasks?: ReadonlyArray<BackgroundTaskSnapshot>;
  readonly logs?: BackgroundLogSlice;
  readonly wait?: BackgroundTaskWaitResult;
  readonly removed?: number;
  readonly truncation?: ReturnType<typeof truncateTail>;
}

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
  const truncation = truncateTail(content, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes,
  });
  const metadata = `[${slice.id} state=${slice.state} cursor=${slice.nextCursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const gap = slice.droppedBytes > 0 ? `[${slice.droppedBytes} earlier log bytes discarded]\n` : "";
  return { text: `${metadata}${gap}${truncation.content || "(no new output)"}`, truncation };
};

const reply = (text: string, details: BackgroundTaskToolDetails): BackgroundTaskCommandResult => ({
  text,
  details,
});

export interface BackgroundTaskCommandOptions {
  readonly maxTextBytes?: number;
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
        const snapshot = yield* service.start({
          command: yield* required(input.command, "command"),
          cwd: path.resolve(sessionCwd, input.cwd ?? "."),
          ...(input.name && { name: input.name }),
          ...(input.timeoutSeconds !== undefined && {
            timeoutSeconds: input.timeoutSeconds,
          }),
        });
        return reply(boundedText(`Started ${formatBackgroundTask(snapshot)}`, maxTextBytes), {
          action: input.action,
          snapshot,
        });
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
        const logs = yield* service.logs({
          id: yield* required(input.id, "id"),
          ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
          ...(input.tailLines !== undefined && { tailLines: input.tailLines }),
          ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
        });
        const formatted = formatLogs(logs, maxTextBytes);
        const details: BackgroundTaskToolDetails = {
          action: input.action,
          logs: { ...logs, events: [] },
        };
        return reply(
          boundedText(formatted.text, maxTextBytes),
          formatted.truncation.truncated
            ? { ...details, truncation: formatted.truncation }
            : details,
        );
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
