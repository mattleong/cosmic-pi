import type { CompactIssue } from "pi-code-previews";
import { formatBytes, formatDuration } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import type { BackgroundTaskSnapshot } from "../task/model.ts";
import { BackgroundTaskFailureDetailsSchema } from "../task/schema.ts";
import type { BackgroundTaskFailureDetails, BackgroundTaskToolDetails } from "../tools/command.ts";
import { taskDisplayName } from "./task-state.ts";

export const decodeBackgroundTaskFailure = Schema.decodeUnknownOption(
  BackgroundTaskFailureDetailsSchema,
);

type Failure = BackgroundTaskFailureDetails["failure"];

const joined = (parts: ReadonlyArray<string | undefined>): string =>
  Arr.join(
    Arr.filter(parts, (part): part is string => part !== undefined && part !== ""),
    " · ",
  );

const argumentList = (fields: ReadonlyArray<string>): string => {
  const names = Arr.map(fields, sanitizeTerminalLine);
  const last = names.at(-1) ?? "";
  return names.length < 2 ? last : `${Arr.join(names.slice(0, -1), ", ")} and ${last}`;
};

// What a rejected request got wrong, worded for one argument or several.
const ARGUMENT_PROBLEMS = {
  missing: (list: string, several: boolean) => `Missing the ${list} argument${several ? "s" : ""}`,
  unexpected: (list: string, several: boolean) =>
    several
      ? `The ${list} arguments don't apply to this action`
      : `The ${list} argument doesn't apply to this action`,
  conflicting: (list: string) => `The ${list} arguments can't be used together`,
  invalid: (list: string, several: boolean) =>
    several ? `The ${list} arguments aren't valid` : `The ${list} argument isn't valid`,
} as const;

const argumentMessage =
  (problem: keyof typeof ARGUMENT_PROBLEMS) =>
  (failure: Failure): string => {
    const fields = failure.fields ?? [];
    const list = argumentList(fields);
    return list === ""
      ? "The request's arguments weren't valid"
      : ARGUMENT_PROBLEMS[problem](list, fields.length > 1);
  };

const FAILURE_MESSAGES = {
  missing_argument: argumentMessage("missing"),
  unexpected_argument: argumentMessage("unexpected"),
  conflicting_arguments: argumentMessage("conflicting"),
  invalid_argument: argumentMessage("invalid"),
  invalid_cwd: () => "Couldn't use the working directory",
  not_found: () => "Background task not found",
  cursor_ahead: () => "That log position is past the end of the output",
  capacity: () => "Too many background tasks are already running",
  disabled: () => "Background tasks are turned off",
  spawn_failed: () => "The command couldn't be started",
  stop_unconfirmed: () => "The stop couldn't be confirmed",
  closed: () => "Background tasks are shutting down",
} as const satisfies Record<Failure["code"], (failure: Failure) => string>;

/** The human-facing issue for an expected failure; the model's wording stays in the result. */
export function failureIssue(failure: Failure): CompactIssue {
  // The task may still be stopping, so its outcome is uncertain rather than failed.
  const severity = failure.code === "stop_unconfirmed" ? "warning" : "error";
  return {
    severity,
    code: `failure:${failure.code}`,
    message: FAILURE_MESSAGES[failure.code](failure),
  };
}

/** The technical facts an expanded failure shows. */
export function failureFactLines(failure: Failure): string[] {
  const task = failure.taskId === undefined ? undefined : sanitizeTerminalLine(failure.taskId);
  const cursors =
    failure.afterCursor === undefined
      ? undefined
      : joined([
          `requested cursor ${failure.afterCursor}`,
          failure.latestCursor === undefined ? undefined : `latest ${failure.latestCursor}`,
        ]);
  return Arr.filter(
    [
      joined([task, cursors]),
      failure.cwd === undefined ? "" : sanitizeTerminalLine(failure.cwd),
      failure.limit === undefined ? "" : `limit ${failure.limit} running`,
    ],
    (line) => line !== "",
  );
}

const taskFacts = (task: BackgroundTaskSnapshot): string =>
  joined([
    task.id,
    sanitizeTerminalLine(task.cwd),
    task.pid === undefined ? undefined : `pid ${task.pid}`,
  ]);

/** The technical facts an expanded result shows: IDs, directories, processes, and cursors. */
export function resultFactLines(details: BackgroundTaskToolDetails): string[] {
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return [taskFacts(details.snapshot)];
    case "wait": {
      const { wait, appliedWaitSeconds } = details;
      return [
        taskFacts(wait.snapshot),
        joined([
          `cursor ${wait.matchCursor ?? wait.nextCursor}`,
          `wait limit ${formatDuration(appliedWaitSeconds * 1_000)}`,
        ]),
      ];
    }
    case "logs": {
      const { logs } = details;
      return [
        joined([
          logs.id,
          `next cursor ${logs.nextCursor}`,
          `earliest ${logs.earliestAvailableCursor}`,
          logs.droppedBytes > 0 ? `${formatBytes(logs.droppedBytes)} discarded so far` : undefined,
        ]),
      ];
    }
    case "list":
    case "stop_all":
      return Arr.map(details.tasks, (task) => `${taskDisplayName(task)}: ${taskFacts(task)}`);
    case "clear":
      return [];
  }
  return [];
}
