import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { sanitizeTerminalLine, countLabel } from "pi-cosmic-core";
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
import {
  clearContract,
  combinedLogOutput,
  logsContract,
  taskActionContract,
  tasksActionContract,
  waitContract,
} from "./contract.ts";
import type { BackgroundTaskContract } from "./contract-schema.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";

export type BackgroundTaskToolDetails = typeof BackgroundTaskDetailsSchema.Type;

/** The legacy text and persisted-details pair that Code Mode v1 and presentation consume. */
export interface BackgroundTaskCommandResult {
  readonly text: string;
  readonly details: BackgroundTaskToolDetails;
}

/**
 * A command result plus its version-1 machine-readable contract. All three projections come from
 * the same original domain facts; the contract never reads the text or details.
 */
export interface BackgroundTaskContractResult extends BackgroundTaskCommandResult {
  readonly contract: BackgroundTaskContract;
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

/** The output a `logs` text keeps and how much of it that is. */
type LogTail = Pick<TruncationResult, "content" | "outputBytes" | "outputLines">;
const NO_TAIL: LogTail = { content: "", outputBytes: 0, outputLines: 0 };

/**
 * The longest tail of `whole` that `fits` accepts. A longer tail never encodes smaller, so a
 * binary search over the byte bound finds it with a few cuts of the already bounded output.
 */
const fittingTail = (whole: TruncationResult, fits: (tail: string) => boolean): LogTail => {
  if (fits(whole.content)) return whole;
  let best = NO_TAIL;
  let low = 0;
  let high = whole.outputBytes - 1;
  while (low <= high) {
    const maxBytes = Math.floor((low + high) / 2);
    const candidate = truncateTail(whole.content, { maxLines: DEFAULT_MAX_LINES, maxBytes });
    if (fits(candidate.content)) {
      best = candidate;
      low = maxBytes + 1;
    } else high = maxBytes - 1;
  }
  return best;
};

/**
 * `content` is the slice's sanitized combined output, shared with its contract. The output is cut
 * once, from its oldest end, within what the metadata lines and `fits` leave of the text's bounds,
 * so the newest lines survive and the truncation fields describe exactly what the text holds.
 */
const formatLogs = (
  slice: BackgroundLogSlice,
  content: string,
  maxBytes: number,
  fits: (text: string) => boolean,
) => {
  // `backgroundLogLines` reads this layout back: one metadata line, then the gap line, if any.
  const metadata = `[${slice.id} state=${slice.state} cursor=${slice.nextCursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const gap = slice.droppedBytes > 0 ? `[${discardedOutputText(slice.droppedBytes)}]\n` : "";
  const header = `${metadata}${gap}`;
  if (!content) return { text: boundedText(`${header}${NO_NEW_OUTPUT}`, maxBytes) };
  const headerBytes = utf8ByteLength(header);
  const whole = truncateTail(content, {
    maxLines: DEFAULT_MAX_LINES - (gap ? 2 : 1),
    maxBytes: Math.max(0, maxBytes - headerBytes),
  });
  const tail =
    headerBytes > maxBytes ? NO_TAIL : fittingTail(whole, (output) => fits(`${header}${output}`));
  return {
    text: headerBytes > maxBytes ? boundedText(header, maxBytes) : `${header}${tail.content}`,
    // Five explicit fields: persisted details never store the truncated log text a second time.
    truncation:
      whole.truncated || tail !== whole
        ? {
            truncated: true,
            outputBytes: tail.outputBytes,
            totalBytes: whole.totalBytes,
            // A tail cut to nothing holds no line, not one empty partial line.
            outputLines: tail.content ? tail.outputLines : 0,
            totalLines: whole.totalLines,
          }
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

const reply = (
  text: string,
  details: BackgroundTaskToolDetails,
  contract: BackgroundTaskContract,
): BackgroundTaskContractResult => ({ text, details, contract });

/** The exact successful-start formatter used by execution and Code Mode admission. */
export const backgroundTaskStartCommandResult = (
  snapshot: BackgroundTaskStatus,
  maxTextBytes: number,
): BackgroundTaskContractResult =>
  reply(
    boundedText(`Started ${formatBackgroundTask(snapshot)}`, maxTextBytes),
    { action: "start", snapshot: detailsSnapshot(snapshot) },
    taskActionContract("start", snapshot),
  );

/** One task's result: its line (with any cause) bounded, and the details pointing at the cause. */
const taskReply = (
  line: string,
  task: BackgroundTaskStatus,
  maxTextBytes: number,
  details: (snapshot: BackgroundTaskSnapshot) => BackgroundTaskToolDetails,
  contract: BackgroundTaskContract,
): BackgroundTaskContractResult => {
  const composed = withCause(line, task);
  const text = boundedText(composed.text, maxTextBytes);
  return reply(
    text,
    { ...details(detailsSnapshot(task)), ...causeSpans(text, composed.causes) },
    contract,
  );
};

export interface BackgroundTaskCommandOptions {
  readonly maxTextBytes?: number;
  /** Optional nested-call barrier, evaluated after exact start normalization and before service.start. */
  readonly startOutputFits?: (request: StartBackgroundTask, maxTextBytes: number) => boolean;
  /**
   * Optional nested-call bound on a `logs` result beyond `maxTextBytes`, such as its encoded
   * envelope. The text keeps the newest output this accepts.
   */
  readonly logsTextFits?: (text: string, logs: BackgroundLogMetadata) => boolean;
}

const acceptAnyText = (): boolean => true;

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
        return reply(
          listed.text,
          {
            action: input.action,
            tasks: tasks.map(detailsSnapshot),
            ...causeSpans(listed.text, listed.causes),
          },
          tasksActionContract(input.action, tasks),
        );
      }
      case "status": {
        const task = yield* service.status(yield* required(input.id, "id", input.action));
        return taskReply(
          formatBackgroundTask(task),
          task,
          maxTextBytes,
          (snapshot) => ({ action: "status", snapshot }),
          taskActionContract("status", task),
        );
      }
      case "logs": {
        const slice = yield* service.logs({
          id: yield* required(input.id, "id", input.action),
          ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
          ...(input.tailLines !== undefined && { tailLines: input.tailLines }),
          ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
        });
        const output = combinedLogOutput(slice.events);
        const { events: _events, ...logs } = slice;
        const fits = options.logsTextFits;
        const { text, truncation } = formatLogs(
          slice,
          output,
          maxTextBytes,
          fits ? (candidate) => fits(candidate, logs) : acceptAnyText,
        );
        return reply(
          text,
          { action: input.action, logs, ...(truncation && { truncation }) },
          logsContract(slice, output),
        );
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
        const { appliedWaitSeconds, ...member } = wait;
        return taskReply(
          formatWait(wait),
          wait.snapshot,
          maxTextBytes,
          (snapshot) => ({ action: "wait", wait: { ...member, snapshot }, appliedWaitSeconds }),
          waitContract(wait),
        );
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
          (snapshot) => ({ action: "stop", snapshot }),
          taskActionContract("stop", task),
        );
      }
      case "stop_all": {
        const tasks = yield* service.stopAll(input.force);
        return reply(
          boundedText(`Stopped ${countLabel(tasks.length, "background task")}.`, maxTextBytes),
          { action: input.action, tasks: tasks.map(detailsSnapshot) },
          tasksActionContract(input.action, tasks),
        );
      }
      case "clear": {
        const removed = yield* service.clear;
        return reply(
          boundedText(`Cleared ${countLabel(removed, "completed background task")}.`, maxTextBytes),
          { action: input.action, removed },
          clearContract(removed),
        );
      }
    }
  });
