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
  countLabel,
} from "pi-cosmic-core";
import { InvalidBackgroundCommandError } from "../task/errors.ts";
import {
  discardedOutputText,
  type BackgroundLogMetadata,
  type BackgroundLogSlice,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
  type BackgroundTaskStatusWait,
  type StartBackgroundTask,
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
  action: BackgroundTaskToolInput["action"],
): Effect.Effect<string, InvalidBackgroundCommandError> =>
  value?.trim()
    ? Effect.succeed(value.trim())
    : new InvalidBackgroundCommandError({ message: `The ${action} action requires ${field}.` });

const MAX_TASK_LINE_CHARS = 8_192;
const ERROR_PREFIX = "\n  error: ";

/**
 * The agent's line for one task: identity, state, exit code and signal, then the command, with
 * any reported error on its own line beneath.
 */
export const formatBackgroundTask = (task: BackgroundTaskSnapshot): string => {
  const exit = task.exitCode === undefined ? "" : ` code=${task.exitCode ?? "null"}`;
  const signal = task.signal ? ` signal=${task.signal}` : "";
  const line = truncateLine(
    sanitizeTerminalLine(
      `${task.id}${task.name ? ` ${task.name}` : ""} ${task.state}${exit}${signal} — ${task.command}`,
    ),
    MAX_TASK_LINE_CHARS,
  ).text;
  const error = task.error && sanitizeTerminalLine(task.error);
  return error ? `${line}${ERROR_PREFIX}${truncateLine(error, MAX_TASK_LINE_CHARS).text}` : line;
};

const boundedText = (text: string, maxBytes: number): string =>
  truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes }).content;

/** A failed task's cause as it appears in the composed text, before truncation. */
interface CauseText {
  readonly id: string;
  readonly start: number;
  readonly end: number;
  readonly cause: string;
}
/** Composed result text and where each failed task's cause sits in it. */
interface TaskText {
  readonly text: string;
  readonly causes: ReadonlyArray<CauseText>;
}

const CAUSE_PREFIX = "\n  cause: ";

/** The persisted v1 snapshot. The in-memory cause travels only in the result text. */
const detailsSnapshot = ({
  failureCause: _cause,
  ...snapshot
}: BackgroundTaskStatus): BackgroundTaskSnapshot => snapshot;

/** `line`, then the task's cause beneath it when the task failed. */
const withCause = (line: string, task: BackgroundTaskStatus): TaskText => {
  if (!task.failureCause) return { text: line, causes: [] };
  const cause = sanitizeTerminalLine(task.failureCause);
  const start = line.length + CAUSE_PREFIX.length;
  return {
    text: `${line}${CAUSE_PREFIX}${cause}`,
    causes: [{ id: task.id, start, end: start + cause.length, cause }],
  };
};

/** Spans for the causes the final, possibly truncated, text still holds whole. */
const causeSpans = (text: string, causes: ReadonlyArray<CauseText>) => {
  const kept = causes
    .filter((span) => text.slice(span.start, span.end) === span.cause)
    .map(({ id, start, end }) => ({ id, start, end }));
  return kept.length > 0 ? { causes: kept } : {};
};

const formatTaskList = (tasks: ReadonlyArray<BackgroundTaskStatus>, maxBytes: number): TaskText => {
  if (tasks.length === 0)
    return { text: boundedText("No background tasks.", maxBytes), causes: [] };
  const lines: string[] = [];
  const causes: CauseText[] = [];
  let used = 0;
  let length = 0;
  for (const [index, task] of tasks.entries()) {
    const separatorBytes = lines.length === 0 ? 0 : 1;
    const block = withCause(formatBackgroundTask(task), task);
    const line = block.text;
    const lineBytes = utf8ByteLength(line);
    const omittedAfter = tasks.length - index - 1;
    const markerAfter = `[${countLabel(omittedAfter, "background task")} omitted]`;
    const reservedMarkerBytes = omittedAfter > 0 ? 1 + utf8ByteLength(markerAfter) : 0;
    if (used + separatorBytes + lineBytes + reservedMarkerBytes > maxBytes) {
      const omitted = tasks.length - index;
      const marker = `[${countLabel(omitted, "background task")} omitted]`;
      const markerBytes = utf8ByteLength(marker);
      if (used + separatorBytes + markerBytes <= maxBytes) lines.push(marker);
      break;
    }
    const offset = length + separatorBytes;
    causes.push(
      ...block.causes.map((span) => ({
        ...span,
        start: span.start + offset,
        end: span.end + offset,
      })),
    );
    lines.push(line);
    used += separatorBytes + lineBytes;
    length = offset + line.length;
  }
  return { text: lines.join("\n"), causes };
};

const formatWait = (result: BackgroundTaskStatusWait): string => {
  const cursor = result.matchCursor ?? result.nextCursor;
  return sanitizeTerminalLine(
    `${result.id} ${result.outcome} state=${result.snapshot.state} cursor=${cursor}`,
  );
};

const NO_NEW_OUTPUT = "(no new output)";

const formatLogs = (slice: BackgroundLogSlice, maxBytes: number) => {
  const content = sanitizeTerminalText(
    slice.events
      .map((event) => `${event.stream === "stderr" ? "[stderr] " : ""}${event.text}`)
      .join(""),
  );
  const cut = truncateTail(content, { maxLines: DEFAULT_MAX_LINES, maxBytes });
  const { truncated, outputBytes, totalBytes, outputLines, totalLines } = cut;
  // `backgroundLogLines` reads this layout back: one metadata line, then the gap line, if any.
  const metadata = `[${slice.id} state=${slice.state} cursor=${slice.nextCursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const gap = slice.droppedBytes > 0 ? `[${discardedOutputText(slice.droppedBytes)}]\n` : "";
  return {
    text: `${metadata}${gap}${cut.content || NO_NEW_OUTPUT}`,
    // Five explicit fields: persisted details never store the truncated log text a second time.
    truncation: truncated
      ? { truncated, outputBytes, totalBytes, outputLines, totalLines }
      : undefined,
  };
};

/**
 * The log lines of a `logs` result's text, without the metadata and discarded-output lines this
 * module writes before them. Empty when the slice had no new output.
 */
export const backgroundLogLines = (
  text: string,
  logs: Pick<BackgroundLogMetadata, "droppedBytes">,
): ReadonlyArray<string> => {
  const lines = text
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u)
    .slice(logs.droppedBytes > 0 ? 2 : 1);
  return lines.length === 1 && lines[0] === NO_NEW_OUTPUT ? [] : lines;
};

const reply = (text: string, details: BackgroundTaskToolDetails): BackgroundTaskCommandResult => ({
  text,
  details,
});

/** The exact successful-start formatter used by execution and Code Mode admission. */
export const backgroundTaskStartCommandResult = (
  snapshot: BackgroundTaskStatus,
  maxTextBytes: number,
): BackgroundTaskCommandResult =>
  reply(boundedText(`Started ${formatBackgroundTask(snapshot)}`, maxTextBytes), {
    action: "start",
    snapshot: detailsSnapshot(snapshot),
  });

/** One task's result: its line (with any cause) bounded, and the details pointing at the cause. */
const taskReply = (
  line: string,
  task: BackgroundTaskStatus,
  maxTextBytes: number,
  details: (snapshot: BackgroundTaskSnapshot) => BackgroundTaskToolDetails,
): BackgroundTaskCommandResult => {
  const composed = withCause(line, task);
  const text = boundedText(composed.text, maxTextBytes);
  return reply(text, { ...details(detailsSnapshot(task)), ...causeSpans(text, composed.causes) });
};

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
          command: yield* required(input.command, "command", input.action),
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
        const listed = formatTaskList(tasks, maxTextBytes);
        return reply(listed.text, {
          action: input.action,
          tasks: tasks.map(detailsSnapshot),
          ...causeSpans(listed.text, listed.causes),
        });
      }
      case "status": {
        const task = yield* service.status(yield* required(input.id, "id", input.action));
        return taskReply(formatBackgroundTask(task), task, maxTextBytes, (snapshot) => ({
          action: "status",
          snapshot,
        }));
      }
      case "logs": {
        const slice = yield* service.logs({
          id: yield* required(input.id, "id", input.action),
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
            message: "The wait action requires until.",
          });
        }
        const wait = yield* service.wait({
          id: yield* required(input.id, "id", input.action),
          until: input.until,
          ...(input.contains !== undefined && { contains: input.contains }),
          ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
          ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
        });
        return taskReply(formatWait(wait), wait.snapshot, maxTextBytes, (snapshot) => ({
          action: "wait",
          wait: { ...wait, snapshot },
        }));
      }
      case "stop": {
        const task = yield* service.stop(
          yield* required(input.id, "id", input.action),
          input.force,
        );
        return taskReply(
          `Stopped ${formatBackgroundTask(task)}`,
          task,
          maxTextBytes,
          (snapshot) => ({
            action: "stop",
            snapshot,
          }),
        );
      }
      case "stop_all": {
        const tasks = yield* service.stopAll(input.force);
        return reply(
          boundedText(`Stopped ${countLabel(tasks.length, "background task")}.`, maxTextBytes),
          { action: input.action, tasks: tasks.map(detailsSnapshot) },
        );
      }
      case "clear": {
        const removed = yield* service.clear;
        return reply(
          boundedText(`Cleared ${countLabel(removed, "completed background task")}.`, maxTextBytes),
          { action: input.action, removed },
        );
      }
    }
  });
