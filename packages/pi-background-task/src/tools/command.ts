import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { sanitizeTerminalLine, countLabel, formatBytes, utf8ByteLength } from "pi-cosmic-core";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import { InvalidBackgroundCommandError } from "../task/errors.ts";
import {
  discardedOutputText,
  type BackgroundLogMetadata,
  type BackgroundLogSlice,
  type BackgroundTaskSnapshot,
  type BackgroundTaskStatus,
  type BackgroundTaskStatusWait,
  type ReadBackgroundLogs,
  type StartBackgroundTask,
  type WaitForBackgroundTask,
} from "../task/model.ts";
import { BACKGROUND_TASK_ACTIONS, type BackgroundTaskDetailsSchema } from "../task/schema.ts";
import { BackgroundTaskService, type BackgroundTaskFilter } from "../task/service.ts";
import {
  clearContract,
  logsContract,
  redactedLine,
  stopContract,
  taskActionContract,
  tasksActionContract,
  waitContract,
} from "./contract.ts";
import type { BackgroundTaskContract } from "./contract-schema.ts";
import { pageLogSlice, pageOmission, type LogPageOmission } from "./log-page.ts";
import type { BackgroundTaskToolInput } from "./schema.ts";

export type BackgroundTaskToolDetails = typeof BackgroundTaskDetailsSchema.Type;

export interface BackgroundTaskContractResult {
  readonly text: string;
  readonly details: BackgroundTaskToolDetails;
  readonly contract: BackgroundTaskContract;
}

type BackgroundTaskAction = BackgroundTaskToolInput["action"];
type BackgroundTaskField = Exclude<keyof BackgroundTaskToolInput, "action">;

/** A non-blank value, as submitted. */
const present = (
  value: string | undefined,
  field: string,
  action: BackgroundTaskAction,
): Effect.Effect<string, InvalidBackgroundCommandError> =>
  value?.trim()
    ? Effect.succeed(value)
    : new InvalidBackgroundCommandError({ message: `The ${action} action requires ${field}.` });

const required = (value: string | undefined, field: string, action: BackgroundTaskAction) =>
  Effect.map(present(value, field, action), (text) => text.trim());

// The flat parameter schema stays provider-portable; each action accepts only its own fields.
const FIELD_ACTIONS = {
  command: ["start"],
  cwd: ["start"],
  name: ["start"],
  timeoutSeconds: ["start"],
  id: ["status", "logs", "wait", "stop"],
  state: ["list"],
  until: ["wait"],
  contains: ["wait"],
  afterCursor: ["logs", "wait"],
  tailLines: ["logs"],
  waitSeconds: ["logs", "wait"],
  force: ["stop", "stop_all"],
} as const satisfies {
  readonly [Field in BackgroundTaskField]: ReadonlyArray<BackgroundTaskAction>;
};

const UNKNOWN_ACTION = "Unknown background task action.";

const isBackgroundTaskAction = (action: string): action is BackgroundTaskAction =>
  BACKGROUND_TASK_ACTIONS.some((known) => known === action);

const fieldList = (fields: ReadonlyArray<string>): string =>
  fields.length < 3
    ? fields.join(" or ")
    : `${fields.slice(0, -1).join(", ")}, or ${fields.at(-1) ?? ""}`;

const invalidCommand = (message: string) =>
  Effect.fail(new InvalidBackgroundCommandError({ message }));

// Placeholders that models fill unused fields with; they carry no request, so an action that
// does not use the field ignores them instead of rejecting the call.
const isPlaceholder = (value: BackgroundTaskToolInput[BackgroundTaskField]): boolean =>
  value === undefined ||
  value === false ||
  value === 0 ||
  (Predicate.isString(value) && value.trim() === "");

const validateFields = (
  input: BackgroundTaskToolInput,
): Effect.Effect<void, InvalidBackgroundCommandError> => {
  const { action } = input;
  if (!isBackgroundTaskAction(action)) return invalidCommand(UNKNOWN_ACTION);
  const rejected = Record.keys(FIELD_ACTIONS).filter(
    (field) =>
      !isPlaceholder(input[field]) && !FIELD_ACTIONS[field].some((accepted) => accepted === action),
  );
  if (rejected.length > 0)
    return invalidCommand(`The ${action} action does not accept ${fieldList(rejected)}.`);
  if (action === "logs" && input.afterCursor !== undefined && !isPlaceholder(input.tailLines))
    return invalidCommand("The logs action accepts afterCursor or tailLines, not both.");
  return Effect.void;
};

const MAX_TASK_LINE_CHARS = 8_192;
const ERROR_PREFIX = "\n  error: ";

const formatBackgroundTask = (task: BackgroundTaskSnapshot): string => {
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

const CAUSE_PREFIX = "\n  cause: ";

// Details keep the same short, redacted cause that the text shows, so rendering never
// depends on the result text a tool_result hook may have rewritten.
const detailsSnapshot = ({
  failureCause,
  ...snapshot
}: BackgroundTaskStatus): BackgroundTaskSnapshot => {
  const cause = redactedLine(failureCause, BACKGROUND_TASK_FIELD_BOUNDS.maxErrorChars);
  return cause === undefined ? snapshot : { ...snapshot, failureCause: cause };
};

const withCause = (line: string, task: BackgroundTaskSnapshot): string =>
  task.failureCause ? `${line}${CAUSE_PREFIX}${task.failureCause}` : line;

const omittedMarker = (count: number) => `[${countLabel(count, "background task")} omitted]`;

const EMPTY_LISTS = {
  active: "No active background tasks.",
  completed: "No completed background tasks.",
  all: "No background tasks.",
} as const satisfies { readonly [Filter in BackgroundTaskFilter]: string };

const formatTaskList = (
  tasks: ReadonlyArray<BackgroundTaskSnapshot>,
  filter: BackgroundTaskFilter,
  maxBytes: number,
): string => {
  if (tasks.length === 0) return boundedText(EMPTY_LISTS[filter], maxBytes);
  const lines: string[] = [];
  let used = 0;
  for (const [index, task] of tasks.entries()) {
    const separatorBytes = lines.length === 0 ? 0 : 1;
    const line = withCause(formatBackgroundTask(task), task);
    const lineBytes = utf8ByteLength(line);
    const omittedAfter = tasks.length - index - 1;
    const reservedMarkerBytes =
      omittedAfter > 0 ? 1 + utf8ByteLength(omittedMarker(omittedAfter)) : 0;
    if (used + separatorBytes + lineBytes + reservedMarkerBytes > maxBytes) {
      const marker = omittedMarker(tasks.length - index);
      if (used + separatorBytes + utf8ByteLength(marker) <= maxBytes) lines.push(marker);
      break;
    }
    lines.push(line);
    used += separatorBytes + lineBytes;
  }
  return lines.join("\n");
};

const formatWait = (result: BackgroundTaskStatusWait, requestedSeconds?: number): string => {
  const cursor = result.matchCursor ?? result.nextCursor;
  const applied = result.appliedWaitSeconds;
  const capped =
    requestedSeconds !== undefined && applied < requestedSeconds
      ? ` (capped from ${requestedSeconds}s by maxWaitSeconds)`
      : "";
  return sanitizeTerminalLine(
    `${result.id} ${result.outcome} state=${result.snapshot.state} cursor=${cursor} limit=${applied}s${capped}`,
  );
};

const NO_NEW_OUTPUT = "(no new output)";
// Room for the paging notice line, whose cursors and sizes are known only after paging.
const LOG_NOTICE_RESERVE_BYTES = 320;
const LOG_HEADER_LINES = 3;

const pageNotice = (truncation: LogPageOmission, cutCursor: number | undefined): string => {
  const parts: string[] = [];
  if (truncation.cutBytes !== undefined && cutCursor !== undefined)
    parts.push(
      `Cursor ${cutCursor} is larger than this result; ${formatBytes(truncation.cutBytes)} of it is not shown and cannot be paged.`,
    );
  if (truncation.omittedBytes > 0)
    parts.push(
      truncation.omitted === "later"
        ? `More output follows: ${formatBytes(truncation.omittedBytes)} retained after cursor ${truncation.resumeAfterCursor}. Continue with afterCursor=${truncation.resumeAfterCursor}.`
        : `Showing the newest output; ${formatBytes(truncation.omittedBytes)} of earlier retained output is not shown. Read it from afterCursor=${truncation.resumeAfterCursor}.`,
    );
  return `[${parts.join(" ")}]\n`;
};

const formatLogs = (slice: BackgroundLogSlice, direction: "forward" | "tail", maxBytes: number) => {
  const header = (cursor: number) =>
    `[${slice.id} state=${slice.state} cursor=${cursor} earliest=${slice.earliestAvailableCursor}]\n`;
  const loss =
    slice.droppedBytes > 0
      ? `[${discardedOutputText(slice.droppedBytes)}; it cannot be recovered.]\n`
      : "";
  const reserved =
    utf8ByteLength(header(slice.nextCursor)) + utf8ByteLength(loss) + LOG_NOTICE_RESERVE_BYTES;
  const page = pageLogSlice(slice, direction, {
    maxBytes: Math.max(0, maxBytes - reserved),
    maxLines: DEFAULT_MAX_LINES - LOG_HEADER_LINES,
  });
  const truncation = pageOmission(slice, direction, page);
  const notice = truncation ? pageNotice(truncation, page.cut?.cursor) : "";
  const text = `${header(page.nextCursor)}${loss}${notice}${page.output || NO_NEW_OUTPUT}`;
  return { text: boundedText(text, maxBytes), nextCursor: page.nextCursor, truncation };
};

/** The output lines of a logs result, without its header and notice lines. */
export const backgroundLogLines = (
  text: string,
  details: {
    readonly logs: Pick<BackgroundLogMetadata, "droppedBytes">;
    readonly truncation?: unknown;
  },
): ReadonlyArray<string> => {
  const headerLines =
    1 + Number(details.logs.droppedBytes > 0) + Number(details.truncation !== undefined);
  const lines = text
    .replace(/\r?\n$/u, "")
    .split(/\r?\n/u)
    .slice(headerLines);
  return lines.length === 1 && lines[0] === NO_NEW_OUTPUT ? [] : lines;
};

const reply = (
  text: string,
  details: BackgroundTaskToolDetails,
  contract: BackgroundTaskContract,
): BackgroundTaskContractResult => ({ text, details, contract });

const taskReply = (
  line: string,
  task: BackgroundTaskSnapshot,
  maxTextBytes: number,
  details: BackgroundTaskToolDetails,
  contract: BackgroundTaskContract,
): BackgroundTaskContractResult =>
  reply(boundedText(withCause(line, task), maxTextBytes), details, contract);

const logsRequest = (input: BackgroundTaskToolInput) =>
  Effect.map(
    required(input.id, "id", input.action),
    (id): ReadBackgroundLogs => ({
      id,
      ...(input.afterCursor !== undefined && { afterCursor: input.afterCursor }),
      // Zero lines is a placeholder for the default window.
      ...(input.tailLines !== undefined && input.tailLines > 0 && { tailLines: input.tailLines }),
      ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
    }),
  );

const waitRequest = Effect.fn("BackgroundTaskCommand.waitRequest")(function* (
  input: BackgroundTaskToolInput,
) {
  const until = input.until;
  if (until === undefined) {
    return yield* new InvalidBackgroundCommandError({
      message: "The wait action requires until.",
    });
  }
  // An exit wait does not use contains or afterCursor, so it ignores their placeholders.
  const exitPlaceholder = (value: string | number | undefined) =>
    until === "exit" && isPlaceholder(value);
  const request: WaitForBackgroundTask = {
    id: yield* required(input.id, "id", input.action),
    until,
    ...(input.contains !== undefined &&
      !exitPlaceholder(input.contains) && { contains: input.contains }),
    ...(input.afterCursor !== undefined &&
      !exitPlaceholder(input.afterCursor) && { afterCursor: input.afterCursor }),
    ...(input.waitSeconds !== undefined && { waitSeconds: input.waitSeconds }),
  };
  return request;
});

export const executeBackgroundTaskCommand = Effect.fn("BackgroundTaskCommand.execute")(function* (
  input: BackgroundTaskToolInput,
  sessionCwd: string,
  maxTextBytes: number = DEFAULT_MAX_BYTES,
) {
  yield* validateFields(input);
  const service = yield* BackgroundTaskService;
  const path = yield* Path.Path;
  switch (input.action) {
    case "start": {
      const name = input.name?.trim();
      const request: StartBackgroundTask = {
        command: yield* present(input.command, "command", input.action),
        cwd: path.resolve(sessionCwd, input.cwd ?? "."),
        ...(name && { name }),
        ...(input.timeoutSeconds !== undefined && {
          timeoutSeconds: input.timeoutSeconds,
        }),
      };
      const task = yield* service.start(request);
      const snapshot = detailsSnapshot(task);
      return taskReply(
        `Started ${formatBackgroundTask(snapshot)}`,
        snapshot,
        maxTextBytes,
        { action: "start", snapshot },
        taskActionContract("start", task),
      );
    }
    case "list": {
      const filter = input.state ?? "all";
      const tasks = yield* service.list(filter);
      const snapshots = tasks.map(detailsSnapshot);
      return reply(
        formatTaskList(snapshots, filter, maxTextBytes),
        { action: input.action, tasks: snapshots },
        tasksActionContract(input.action, tasks),
      );
    }
    case "status": {
      const task = yield* service.status(yield* required(input.id, "id", input.action));
      const snapshot = detailsSnapshot(task);
      return taskReply(
        formatBackgroundTask(snapshot),
        snapshot,
        maxTextBytes,
        { action: "status", snapshot },
        taskActionContract("status", task),
      );
    }
    case "logs": {
      const request = yield* logsRequest(input);
      const slice = yield* service.logs(request);
      const direction = request.afterCursor === undefined ? "tail" : "forward";
      const { text, nextCursor, truncation } = formatLogs(slice, direction, maxTextBytes);
      const { id, state, earliestAvailableCursor, droppedBytes } = slice;
      const { name, command } = slice.task;
      return reply(
        text,
        {
          action: input.action,
          logs: { id, state, nextCursor, earliestAvailableCursor, droppedBytes },
          task: { ...(name !== undefined && { name }), command },
          ...(truncation && { truncation }),
        },
        logsContract(slice, direction),
      );
    }
    case "wait": {
      const wait = yield* service.wait(yield* waitRequest(input));
      const { appliedWaitSeconds, ...member } = wait;
      const snapshot = detailsSnapshot(wait.snapshot);
      return taskReply(
        formatWait(wait, input.waitSeconds),
        snapshot,
        maxTextBytes,
        { action: "wait", wait: { ...member, snapshot }, appliedWaitSeconds },
        waitContract(wait),
      );
    }
    case "stop": {
      const stop = yield* service.stop(yield* required(input.id, "id", input.action), input.force);
      // Only the service knows whether the task finished before this stop landed.
      const { alreadyFinished } = stop;
      const snapshot = detailsSnapshot(stop.snapshot);
      return taskReply(
        `${alreadyFinished ? "Already finished; nothing to stop:" : "Stopped"} ${formatBackgroundTask(snapshot)}`,
        snapshot,
        maxTextBytes,
        { action: "stop", snapshot, alreadyFinished },
        stopContract(stop),
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
  return yield* new InvalidBackgroundCommandError({ message: UNKNOWN_ACTION });
});
