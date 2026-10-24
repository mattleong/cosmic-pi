import { exitStatusMeaning } from "pi-code-previews";
import type {
  CompactIssue,
  CompactOutcome,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import { clipText, countLabel, formatBytes, formatDuration } from "pi-cosmic-core/display";
import { firstLineMessage, quoteText } from "pi-cosmic-core/message-text";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core/security";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import {
  countTaskStates,
  discardedOutputText,
  failingExitCode,
  isActiveTaskState,
  type BackgroundLogMetadata,
  type BackgroundTaskSnapshot,
} from "../task/model.ts";
import { BACKGROUND_TASK_STATES, BackgroundTaskDetailsSchema } from "../task/schema.ts";
import type { BackgroundTaskToolDetails } from "../tools/command.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";
import { taskDisplayName, taskStateLabel } from "./task-state.ts";

export const decodeBackgroundTaskDetails = Schema.decodeUnknownOption(BackgroundTaskDetailsSchema);

const MAX_TASK_LABEL_CHARS = 40;
const MAX_QUOTED_CHARS = 40;
const MAX_CAUSE_CHARS = 60;

const SEVERITY_ORDER: ReadonlyArray<CompactIssue["severity"]> = ["error", "warning", "info"];

export const backgroundTaskActionLabel = (action: string): string =>
  action === "stop_all" ? "stop all" : sanitizeTerminalLine(action);

export const quotedWaitText = (text: string): string =>
  `"${clipText(sanitizeTerminalLine(text), MAX_QUOTED_CHARS)}"`;

const textValue = (value: string | undefined) => (Predicate.isString(value) ? value : "");

/** The non-empty texts an output wait was asked to find, from one text or a list. */
const waitTexts = (args: Partial<BackgroundTaskToolInput>): ReadonlyArray<string> => {
  if (args.until !== "output") return [];
  const { contains } = args;
  const texts = Predicate.isString(contains) ? [contains] : Arr.isArray(contains) ? contains : [];
  return Arr.filter(texts, (text) => Predicate.isString(text) && Str.isNonEmpty(text));
};

/** The awaited texts, quoted: one, two joined by "or", or the first and how many others. */
const awaitedText = (texts: ReadonlyArray<string>): string => {
  const [first, second] = texts;
  if (first === undefined) return "";
  if (second === undefined) return quotedWaitText(first);
  return texts.length === 2
    ? `${quotedWaitText(first)} or ${quotedWaitText(second)}`
    : `${quotedWaitText(first)} or ${countLabel(texts.length - 1, "other")}`;
};

function waitSubject(args: Partial<BackgroundTaskToolInput>): string {
  if (args.until === "exit") return "for exit";
  const awaited = awaitedText(waitTexts(args));
  return awaited ? `for ${awaited}` : "";
}

export function backgroundTaskCallSubject(args: Partial<BackgroundTaskToolInput>): string {
  switch (args.action) {
    case "start":
      // Commands may be 64 KiB; clip before sanitizing because this runs on every render.
      return sanitizeTerminalLine(
        clipText(
          Str.trim(textValue(args.name)) || textValue(args.command),
          BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars,
        ),
      );
    case "wait":
      return waitSubject(args);
    case "list":
      return args.state === "active" || args.state === "completed" ? args.state : "";
    case "status":
    case "logs":
    case "stop":
    case "stop_all":
    case "clear":
    case undefined:
      return "";
  }
  return "";
}

export function resultSnapshot(
  details: BackgroundTaskToolDetails,
): BackgroundTaskSnapshot | undefined {
  if (details.action === "start" || details.action === "status" || details.action === "stop")
    return details.snapshot;
  return details.action === "wait" ? details.wait.snapshot : undefined;
}

export function backgroundTaskResultSubject(
  details: BackgroundTaskToolDetails,
  args: Partial<BackgroundTaskToolInput>,
): string {
  const snapshot = resultSnapshot(details);
  if (snapshot) return taskDisplayName(snapshot);
  if (details.action === "logs") return taskDisplayName(details.task);
  return details.action === "list" ? backgroundTaskCallSubject(args) : "";
}

const issue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
): CompactIssue => ({ severity, code, message, ...(detail && { detail }) });

const logLossIssue = (id: string, bytes: number, detail?: string) =>
  issue(
    "warning",
    `${id}:log-loss`,
    discardedOutputText(bytes),
    Arr.join(
      Arr.filter(
        ["Discarded output cannot be recovered.", detail],
        (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
      ),
      " ",
    ),
  );
const cleanupUnconfirmedIssue = (id: string) =>
  issue(
    "warning",
    `${id}:cleanup-unconfirmed`,
    "Some task processes may still be running",
    "Process-tree cleanup is not confirmed; inspect status before retrying work.",
  );
const runtimeTimeoutIssue = (id: string, ranMs: number | undefined, detail?: string) =>
  issue(
    "error",
    `${id}:runtime-timeout`,
    ranMs === undefined ? "Timed out" : `Timed out after ${formatDuration(ranMs)}`,
    detail,
  );

function taskErrorIssue(id: string, error: string): CompactIssue {
  const { line, detail } = quoteText(Str.trim(stripTerminalControls(error)));
  return issue("error", `${id}:error`, line ?? "Reported an error", detail);
}

type TaskSummary = CompactSummary & {
  readonly outcome: CompactOutcome;
  readonly issues: readonly CompactIssue[];
};

function stateDetail(value: BackgroundTaskSnapshot): string {
  const label = taskStateLabel(value.state);
  const endedByUs = value.state === "timed_out" || value.state === "stopped";
  const exitCode = failingExitCode(value);
  return exitCode !== undefined && !endedByUs ? `${label}, exit ${exitCode}` : label;
}

const failureCause = (value: BackgroundTaskSnapshot): string | undefined => {
  const cause = value.failureCause === undefined ? "" : sanitizeTerminalLine(value.failureCause);
  return cause ? clipText(cause, MAX_CAUSE_CHARS) : undefined;
};

function failureIssues(value: BackgroundTaskSnapshot): CompactIssue[] {
  const issues: CompactIssue[] = [];
  const cause = failureCause(value);
  const exitCode = failingExitCode(value);
  if (exitCode !== undefined) {
    const exitCause = cause ?? exitStatusMeaning(exitCode);
    issues.push(
      issue(
        "error",
        `${value.id}:exit-code`,
        `Exited with code ${exitCode}${exitCause ? `: ${exitCause}` : ""}`,
      ),
    );
  }
  if (value.signal) {
    const meaning = exitStatusMeaning(undefined, value.signal);
    issues.push(
      issue(
        "error",
        `${value.id}:signal`,
        firstLineMessage(
          `Received signal ${sanitizeTerminalLine(value.signal)}${meaning ? `: ${meaning}` : ""}`,
          "Received a signal",
        ),
      ),
    );
  }
  if (value.state === "failed" && !value.error && issues.length === 0)
    issues.push(
      issue(
        "error",
        `${value.id}:failed`,
        cause ? `Failed: ${cause}` : "Failed without reporting a cause",
      ),
    );
  return issues;
}

// Only a cleanly exited command is a success; work still starting or running stays neutral.
function taskOutcome(value: BackgroundTaskSnapshot): CompactOutcome {
  if (value.state === "failed" || value.state === "timed_out" || value.error) return "error";
  if (value.state === "stopped") return "cancelled";
  if (failingExitCode(value) !== undefined || value.signal) return "error";
  if (value.state === "stopping" || (value.state === "exited" && value.exitCode !== 0))
    return "uncertain";
  return value.state === "exited" ? "success" : "returned";
}

function taskIssues(value: BackgroundTaskSnapshot, outcome: CompactOutcome): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if (value.state === "timed_out")
    issues.push(
      runtimeTimeoutIssue(
        value.id,
        value.endedAt === undefined ? undefined : value.endedAt - value.startedAt,
      ),
    );
  else if (outcome === "error") issues.push(...failureIssues(value));
  if (value.error) issues.push(taskErrorIssue(value.id, value.error));
  if (value.state === "stopping") issues.push(cleanupUnconfirmedIssue(value.id));
  if (value.state === "exited" && Predicate.isNullish(value.exitCode) && !value.signal)
    issues.push(
      issue(
        "warning",
        `${value.id}:exit-unknown`,
        "Exited, but its outcome is unknown",
        "Process exited, but its exit code is unknown; inspect task status.",
      ),
    );
  if (value.droppedLogBytes > 0) issues.push(logLossIssue(value.id, value.droppedLogBytes));
  return issues;
}

function taskSummary(value: BackgroundTaskSnapshot): TaskSummary {
  const outcome = taskOutcome(value);
  return {
    subject: taskDisplayName(value),
    metadata: [stateDetail(value)],
    outcome,
    issues: taskIssues(value, outcome),
  };
}

/** A finished task's notice: its outcome and issues as a status row has them, and its duration. */
export function taskNoticeSummary(value: BackgroundTaskSnapshot): TaskSummary {
  const task = taskSummary(value);
  const ran = value.endedAt === undefined ? [] : [formatDuration(value.endedAt - value.startedAt)];
  return { ...task, metadata: [...(task.metadata ?? []), ...ran] };
}

// A confirmed stop is the stop action's success, not a cancelled request.
const stopOutcome = (outcome: CompactOutcome): CompactOutcome =>
  outcome === "cancelled" ? "success" : outcome;

function stopSummary(details: DetailsFor<"stop">, action: string): CompactSummary {
  const task = taskSummary(details.snapshot);
  if (!details.alreadyFinished) return { ...task, action, outcome: stopOutcome(task.outcome) };
  return {
    subject: task.subject,
    action,
    metadata: [`already ${stateDetail(details.snapshot)}`],
    outcome: "returned",
    issues: [],
  };
}

function cursorIssues(value: Omit<BackgroundLogMetadata, "state">): CompactIssue[] {
  if (value.droppedBytes <= 0) return [];
  return [
    logLossIssue(
      value.id,
      value.droppedBytes,
      `Retained output is readable from afterCursor ${value.earliestAvailableCursor}; the next read continues after cursor ${value.nextCursor}.`,
    ),
  ];
}

function taskLabels(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const names = Arr.map(tasks, (task) => clipText(taskDisplayName(task), MAX_TASK_LABEL_CHARS));
  return Arr.map(names, (name, index) => {
    const same = Arr.filter(names, (other) => other === name).length;
    if (same === 1) return name;
    return `${name} (${Arr.filter(names.slice(0, index + 1), (other) => other === name).length})`;
  });
}

function waitTimeoutIssue(
  id: string,
  snapshot: BackgroundTaskSnapshot,
  args: Partial<BackgroundTaskToolInput>,
  appliedWaitSeconds: number,
): CompactIssue {
  const state = taskStateLabel(snapshot.state);
  const awaited = awaitedText(waitTexts(args));
  const waited =
    appliedWaitSeconds > 0
      ? `Waited ${formatDuration(appliedWaitSeconds * 1_000)}`
      : "Stopped waiting";
  const requested = Predicate.isNumber(args.waitSeconds) ? args.waitSeconds : undefined;
  const capped =
    requested !== undefined && appliedWaitSeconds < requested
      ? ` The maxWaitSeconds setting capped the requested ${requested}s wait at ${appliedWaitSeconds}s.`
      : "";
  return issue(
    "warning",
    `${id}:wait-timeout`,
    awaited
      ? `${waited} for ${awaited}; the task is still ${state}`
      : `${waited} for the task to exit; it is still ${state}`,
    `Wait timed out; this does not stop the background task. Call wait again to keep waiting.${capped}`,
  );
}

export interface BackgroundTaskCompactSummaryInput {
  readonly phase: CompactPhase;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly result: { details?: unknown } | undefined;
  readonly isError: boolean;
}

type DecodedTaskDetails = typeof BackgroundTaskDetailsSchema.Type;
type DetailsFor<Action extends DecodedTaskDetails["action"]> = Extract<
  DecodedTaskDetails,
  { readonly action: Action }
>;

// Lists succeed only when every listed task did; otherwise the most urgent task outcome leads.
const AGGREGATE_PRECEDENCE: ReadonlyArray<CompactOutcome> = [
  "error",
  "uncertain",
  "warning",
  "cancelled",
  "returned",
];

function aggregateOutcome(outcomes: readonly CompactOutcome[]): CompactOutcome {
  if (outcomes.length === 0) return "returned";
  return Option.getOrElse(
    Arr.findFirst(AGGREGATE_PRECEDENCE, (outcome) => outcomes.includes(outcome)),
    () => "success",
  );
}

function aggregateCounters(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const counts = Arr.flatMap(BACKGROUND_TASK_STATES, (state) => {
    const n = Arr.filter(tasks, (task) => task.state === state).length;
    return n ? [`${n} ${taskStateLabel(state)}`] : [];
  });
  const total = countLabel(tasks.length, "task");
  const { active, failed } = countTaskStates(tasks);
  const brief = Arr.join(
    Arr.filter(
      [total, active ? `${active} active` : "", failed ? `${failed} failed` : ""],
      Boolean,
    ),
    ", ",
  );
  return [...new Set([Arr.join(counts, ", ") || total, brief, total])];
}

function aggregateSummary(
  details: DetailsFor<"list" | "stop_all">,
  action: string,
  subject: string,
): CompactSummary {
  const tasks = Arr.map(details.tasks, taskSummary);
  const labels = taskLabels(details.tasks);
  // Labels are already sanitized display names; tidying the composed text would strip a task
  // named like an error class, such as "BuildError".
  const issues = Arr.flatMap(tasks, (task, index) => {
    const label = labels[index];
    if (label === undefined) return task.issues;
    return Arr.map(task.issues, (entry) => ({ ...entry, message: `${label}: ${entry.message}` }));
  });
  const outcomes = Arr.map(tasks, (task) =>
    details.action === "stop_all" ? stopOutcome(task.outcome) : task.outcome,
  );
  const ordered = Arr.flatMap(SEVERITY_ORDER, (severity) =>
    Arr.filter(issues, (entry) => entry.severity === severity),
  );
  return {
    action,
    subject,
    counters: aggregateCounters(details.tasks),
    issues: ordered,
    outcome: aggregateOutcome(outcomes),
  };
}

function waitMetadata(
  wait: DetailsFor<"wait">["wait"],
  state: string,
  alternatives: number,
): string {
  if (wait.outcome === "matched")
    return alternatives > 1 && wait.matchedText !== undefined
      ? `found ${quotedWaitText(wait.matchedText)}, ${state}`
      : `output found, ${state}`;
  return wait.outcome === "timeout" ? `still ${taskStateLabel(wait.snapshot.state)}` : state;
}

/** An output wait whose task finished first: the awaited text never appeared. */
const unmatchedOutput = (wait: DetailsFor<"wait">["wait"], awaited: string): boolean =>
  wait.outcome === "completed" && awaited !== "";

// The task's own failure or uncertainty leads; otherwise the wait outcome classifies the row.
function waitOutcome(
  wait: DetailsFor<"wait">["wait"],
  task: CompactOutcome,
  unmatched: boolean,
): CompactOutcome {
  if (task === "error" || task === "uncertain") return task;
  if (wait.outcome === "timeout" || unmatched) return "warning";
  return wait.outcome === "matched" ? "success" : task;
}

function waitSummary(
  details: DetailsFor<"wait">,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
): CompactSummary | undefined {
  const { wait } = details;
  if (wait.id !== wait.snapshot.id) return undefined;
  const task = taskSummary(wait.snapshot);
  const issues = [
    ...Arr.filter(task.issues, (entry) => entry.code !== `${wait.id}:log-loss`),
    ...cursorIssues(wait),
  ];
  const texts = waitTexts(args);
  const awaited = awaitedText(texts);
  const unmatched = unmatchedOutput(wait, awaited);
  if (wait.outcome === "timeout")
    issues.unshift(waitTimeoutIssue(wait.id, wait.snapshot, args, details.appliedWaitSeconds));
  // The task's own failure, already listed, explains more than the missing output.
  if (unmatched)
    issues.push(
      issue(
        "warning",
        `${wait.id}:output-missing`,
        `Finished without printing ${awaited}`,
        "The task ended before the awaited output appeared; its recent output is in the result.",
      ),
    );
  const state = task.metadata?.[0] ?? taskStateLabel(wait.snapshot.state);
  return {
    ...task,
    action,
    metadata: [waitMetadata(wait, state, texts.length)],
    issues,
    outcome: waitOutcome(wait, task.outcome, unmatched),
  };
}

function logsIssues(details: DetailsFor<"logs">): CompactIssue[] {
  const logs = details.logs;
  const issues: CompactIssue[] = [];
  if (logs.state === "failed")
    issues.push(
      issue(
        "error",
        `${logs.id}:failed`,
        "Failed",
        "Read task status for the exit code and failure cause.",
      ),
    );
  if (logs.state === "timed_out")
    issues.push(runtimeTimeoutIssue(logs.id, undefined, "Read task status for how long it ran."));
  if (logs.state === "stopping") issues.push(cleanupUnconfirmedIssue(logs.id));
  issues.push(...cursorIssues(logs));
  const page = details.truncation;
  if (page?.cutBytes !== undefined)
    issues.push(
      issue(
        "warning",
        `${logs.id}:output-cut`,
        `${formatBytes(page.cutBytes)} of one output chunk did not fit the result`,
        "The chunk is larger than a whole result, so paging cannot show that part.",
      ),
    );
  if (page && page.omittedBytes > 0)
    issues.push(
      page.omitted === "later"
        ? issue(
            "info",
            `${logs.id}:slice-truncated`,
            `More output follows, ${formatBytes(page.omittedBytes)} retained`,
            `Continue reading with afterCursor ${page.resumeAfterCursor}; each read returns the next page.`,
          )
        : issue(
            "info",
            `${logs.id}:slice-truncated`,
            `Showing the newest output; ${formatBytes(page.omittedBytes)} earlier is retained`,
            `Reading with afterCursor ${page.resumeAfterCursor} returns retained output from its start.`,
          ),
    );
  return issues;
}

function logsOutcome(
  state: BackgroundTaskSnapshot["state"],
  issues: readonly CompactIssue[],
): CompactOutcome {
  if (state === "failed" || state === "timed_out") return "error";
  if (state === "stopped") return "cancelled";
  if (state === "stopping") return "uncertain";
  if (Arr.some(issues, (entry) => entry.severity === "warning")) return "warning";
  return isActiveTaskState(state) ? "returned" : "success";
}

function logsSummary(details: DetailsFor<"logs">, action: string): CompactSummary {
  const issues = logsIssues(details);
  return {
    action,
    subject: taskDisplayName(details.task),
    metadata: [taskStateLabel(details.logs.state)],
    outcome: logsOutcome(details.logs.state, issues),
    issues,
  };
}

export const projectBackgroundTaskCompactSummary = ({
  phase,
  args,
  result,
  isError,
}: BackgroundTaskCompactSummaryInput): CompactSummary | undefined => {
  const action = args.action ?? "task";
  const subject = backgroundTaskCallSubject(args);
  if (phase !== "settled") return { action, subject };
  if (isError) return { action, subject, outcome: "error", issues: [] };
  const decoded = decodeBackgroundTaskDetails(result?.details);
  if (Option.isNone(decoded) || decoded.value.action !== args.action) return undefined;
  return settledSummary(decoded.value, args, action, subject);
};

function settledSummary(
  details: DecodedTaskDetails,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
  subject: string,
): CompactSummary | undefined {
  switch (details.action) {
    case "start":
    case "status":
      return { ...taskSummary(details.snapshot), action };
    case "stop":
      return stopSummary(details, action);
    case "clear":
      return {
        action,
        subject,
        counters: [`${details.removed} removed`],
        outcome: "success",
        issues: [],
      };
    case "list":
    case "stop_all":
      return aggregateSummary(details, action, subject);
    case "wait":
      return waitSummary(details, args, action);
    case "logs":
      return logsSummary(details, action);
  }
  return undefined;
}

export const backgroundTaskCompactSummary: CompactSummaryProvider<BackgroundTaskToolInput> = ({
  phase,
  args,
  result,
  context,
}) => {
  const summary = projectBackgroundTaskCompactSummary({
    phase,
    args,
    result: result && { details: result.details },
    isError: context.isError,
  });
  return summary && args.action
    ? { ...summary, action: backgroundTaskActionLabel(args.action) }
    : summary;
};
