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
import { joinInline } from "pi-cosmic-ui/manager";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../task/bounds.ts";
import {
  countTaskStates,
  failingExitCode,
  isActiveTaskState,
  skippedAmountText,
  type BackgroundOutputSkip,
  type BackgroundTaskSnapshot,
} from "../task/model.ts";
import { BACKGROUND_TASK_STATES, BackgroundTaskDetailsSchema } from "../task/schema.ts";
import type { BackgroundTaskFailureDetails, BackgroundTaskToolDetails } from "../tools/command.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";
import { decodeBackgroundTaskFailure, failureIssue } from "./result-facts.ts";
import { emptyTaskListLabel, taskDisplayName, taskStateLabel } from "./task-state.ts";

export const decodeBackgroundTaskDetails = Schema.decodeUnknownOption(BackgroundTaskDetailsSchema);

const MAX_TASK_LABEL_CHARS = 40;
const MAX_QUOTED_CHARS = 40;
const MAX_CAUSE_CHARS = 60;

const SEVERITY_ORDER: ReadonlyArray<CompactIssue["severity"]> = [
  "error",
  "warning",
  "attention",
  "info",
];

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

function resultSnapshot(details: BackgroundTaskToolDetails): BackgroundTaskSnapshot | undefined {
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

// Only output a read asked for and missed warns; routine eviction of old output does not.
const outputSkippedIssue = (
  id: string,
  skipped: BackgroundOutputSkip,
  reader: "read" | "wait",
  detail: string,
) =>
  issue(
    "warning",
    `${id}:log-loss`,
    `${Str.capitalize(skippedAmountText(skipped))} of output was discarded before this ${reader}`,
    `Discarded output can't be recovered. ${detail}`,
  );
const cleanupUnconfirmedIssue = (id: string) =>
  issue(
    "warning",
    `${id}:cleanup-unconfirmed`,
    "Some task processes may still be running",
    "Cleanup of the task's process tree isn't confirmed yet.",
  );
const runtimeTimeoutIssue = (id: string, ranMs: number | undefined) =>
  issue(
    "error",
    `${id}:runtime-timeout`,
    ranMs === undefined ? "Timed out" : `Timed out after ${formatDuration(ranMs)}`,
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

/** The outcomes one task can have. */
export type TaskOutcome = Extract<
  CompactOutcome,
  "success" | "error" | "cancelled" | "uncertain" | "returned"
>;

// Only a cleanly exited command is a success; work still starting or running stays neutral.
function taskOutcome(value: BackgroundTaskSnapshot): TaskOutcome {
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
        "The process exited without reporting an exit code.",
      ),
    );
  return issues;
}

// Routine eviction keeps a long task's newest output; a read that misses some warns on its own.
const discardedOutputIssue = (value: BackgroundTaskSnapshot): CompactIssue[] =>
  value.droppedLogBytes > 0
    ? [
        issue(
          "info",
          `${value.id}:output-discarded`,
          `${formatBytes(value.droppedLogBytes)} of earlier output was discarded`,
          "The task keeps only its newest output; discarded output can't be recovered.",
        ),
      ]
    : [];

/** A status or notice: the task's own issues, then any output it no longer keeps. */
function taskReportSummary(value: BackgroundTaskSnapshot): TaskSummary {
  const task = taskSummary(value);
  return { ...task, issues: [...task.issues, ...discardedOutputIssue(value)] };
}

/**
 * A start that admitted its task reads as done, so its row never goes stale as "running". The
 * action names what succeeded, `✓ background_task start docs`, since the check alone would read as
 * a finished task and the shell drops `started` beside it.
 */
function startSummary(value: BackgroundTaskSnapshot, action: string): CompactSummary {
  const task = taskSummary(value);
  return value.state === "starting" || value.state === "running"
    ? { ...task, action, metadata: ["started"], outcome: "success" }
    : { ...task, action };
}

/** A timed-out task's issue already says it timed out, so its row doesn't repeat the state. */
const stateMetadata = (state: BackgroundTaskSnapshot["state"]): string[] =>
  state === "timed_out" ? [] : [taskStateLabel(state)];

function taskSummary(value: BackgroundTaskSnapshot): TaskSummary {
  const outcome = taskOutcome(value);
  return {
    subject: taskDisplayName(value),
    // A failing exit code is already the issue's message.
    metadata: stateMetadata(value.state),
    outcome,
    issues: taskIssues(value, outcome),
  };
}

/** A listed task's own issues, which an expanded listing shows beneath the task's row. */
export const listedTaskIssues = (value: BackgroundTaskSnapshot): ReadonlyArray<CompactIssue> =>
  taskSummary(value).issues;

/** A listed task's outcome, which its row marks with the suite's status glyph. */
export const listedTaskOutcome = (value: BackgroundTaskSnapshot): TaskOutcome => taskOutcome(value);

/**
 * A finished task's notice: its outcome and issues as a status row has them, and its run time,
 * unless its timeout issue already states it. The run time joins the state as one fact,
 * `finished in 1m 33s`, because a compact heading shows only its first fact.
 */
export function taskNoticeSummary(value: BackgroundTaskSnapshot): TaskSummary {
  const task = taskReportSummary(value);
  if (value.endedAt === undefined || value.state === "timed_out") return task;
  const ran = formatDuration(value.endedAt - value.startedAt);
  const state = taskStateLabel(value.state);
  return {
    ...task,
    metadata: [value.state === "exited" ? `${state} in ${ran}` : `${state} after ${ran}`],
  };
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
    `Waiting doesn't stop the task.${capped}`,
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
  const failures = failed ? `${failed} failed` : "";
  const brief = joinInline(
    Arr.filter([total, active ? `${active} active` : "", failures], Boolean),
  );
  // Narrower, the failures outlast the active count: a row never loses failure evidence first.
  const failedOnly = joinInline(Arr.filter([total, failures], Boolean));
  return narrowing([joinInline(counts) || total, brief, failedOnly, total]);
}

/** Counter alternatives widest first: each is kept only when narrower than the one before it. */
function narrowing(alternatives: ReadonlyArray<string>): string[] {
  const kept: string[] = [];
  for (const entry of alternatives) {
    const last = kept.at(-1);
    if (last === undefined || entry.length < last.length) kept.push(entry);
  }
  return kept;
}

const LISTED_PROBLEMS: ReadonlyArray<CompactOutcome> = ["error", "warning", "uncertain"];

function aggregateSummary(
  details: DetailsFor<"list" | "stop_all">,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
  subject: string,
): CompactSummary {
  // An empty listing says so in its heading, as its body does, and expanding adds nothing.
  if (details.tasks.length === 0)
    return {
      action,
      subject,
      counters: [emptyTaskListLabel(details.action === "stop_all" ? "active" : args.state)],
      issues: [],
      outcome: "returned",
      expandLabel: false,
    };
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
  const outcome = aggregateOutcome(outcomes);
  // A listing is neutral even when listed tasks failed: its counts say so, and its expanded
  // Tasks section shows each task's issues beneath the task (`listedTaskIssues`).
  const listing = details.action === "list";
  return {
    action,
    subject,
    counters: aggregateCounters(details.tasks),
    issues: listing ? [] : ordered,
    outcome: listing && Arr.contains(LISTED_PROBLEMS, outcome) ? "returned" : outcome,
  };
}

/**
 * What a wait found, and the task's state unless an issue already states it. A match is a counter
 * with narrower alternatives, widest first: which text was found and the task's state, then that
 * output was found with the state, then only that it was found. Other waits state one fact.
 */
function waitFacts(
  wait: DetailsFor<"wait">["wait"],
  state: string | undefined,
  alternatives: number,
): Pick<CompactSummary, "counters" | "metadata"> {
  if (wait.outcome === "matched") {
    const withState = (found: string) => (state === undefined ? found : `${found} · ${state}`);
    const named =
      alternatives > 1 && wait.matchedText !== undefined
        ? [withState(`found ${quotedWaitText(wait.matchedText)}`)]
        : [];
    return {
      counters: [...new Set([...named, withState("output found"), "output found"])],
      metadata: [],
    };
  }
  if (wait.outcome === "timeout")
    return { metadata: [`still ${taskStateLabel(wait.snapshot.state)}`] };
  return { metadata: state === undefined ? [] : [state] };
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
  const issues = [...task.issues];
  if (wait.skipped)
    issues.push(
      outputSkippedIssue(
        wait.id,
        wait.skipped,
        "wait",
        `The wait couldn't search it. Retained output starts at cursor ${wait.earliestAvailableCursor}.`,
      ),
    );
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
        "The task ended before the awaited output appeared.",
      ),
    );
  return {
    ...task,
    action,
    ...waitFacts(wait, task.metadata?.[0], texts.length),
    issues,
    outcome: waitOutcome(wait, task.outcome, unmatched),
  };
}

function logsIssues(details: DetailsFor<"logs">): CompactIssue[] {
  const logs = details.logs;
  const issues: CompactIssue[] = [];
  // A failed task's state is already the row's metadata; its cause belongs to status and wait.
  if (logs.state === "timed_out") issues.push(runtimeTimeoutIssue(logs.id, undefined));
  if (logs.state === "stopping") issues.push(cleanupUnconfirmedIssue(logs.id));
  if (logs.skipped)
    issues.push(
      outputSkippedIssue(
        logs.id,
        logs.skipped,
        "read",
        `Retained output starts at cursor ${logs.earliestAvailableCursor}; the next read continues after cursor ${logs.nextCursor}.`,
      ),
    );
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
  if (page && page.omittedBytes > 0) {
    const later = page.omitted === "later";
    issues.push(
      issue(
        "info",
        `${logs.id}:slice-truncated`,
        later
          ? `More output follows, ${formatBytes(page.omittedBytes)} retained`
          : `Showing the newest output; ${formatBytes(page.omittedBytes)} earlier is retained`,
        `${later ? "It starts" : "Retained output starts"} after cursor ${page.resumeAfterCursor}.`,
      ),
    );
  }
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
    metadata: stateMetadata(details.logs.state),
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
  const action = args.action === undefined ? "task" : backgroundTaskActionLabel(args.action);
  const subject = backgroundTaskCallSubject(args);
  if (phase !== "settled") return { action, subject };
  if (isError) return failureSummary(decodeBackgroundTaskFailure(result?.details), action, subject);
  const decoded = decodeBackgroundTaskDetails(result?.details);
  if (Option.isNone(decoded) || decoded.value.action !== args.action) return undefined;
  const summary = settledSummary(decoded.value, args, action, subject);
  return summary && { expandLabel: settledExpandLabel(decoded.value), ...summary };
};

/**
 * What expanding a settled row reveals that its heading and collapsed body don't: a task's command
 * and identity, its output, or every listed task. A summary may set its own label first.
 */
function settledExpandLabel(details: DecodedTaskDetails): string | false {
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return "details";
    case "wait":
      return details.wait.tail ? "output" : "details";
    case "logs":
      return "output";
    case "list":
    case "stop_all":
      return "tasks";
    case "clear":
      return false;
  }
  return false;
}

// An expected failure names itself; any other error leaves the shell to show the host's text.
function failureSummary(
  failure: Option.Option<BackgroundTaskFailureDetails>,
  action: string,
  subject: string,
): CompactSummary {
  return Option.match(failure, {
    onNone: () => ({ action, subject, outcome: "error", issues: [] }),
    onSome: (details) => {
      const reported = failureIssue(details.failure);
      return {
        action,
        subject,
        outcome: reported.severity === "error" ? "error" : "uncertain",
        issues: [reported],
        // The request's arguments and the failure's facts.
        expandLabel: "details",
      };
    },
  });
}

function settledSummary(
  details: DecodedTaskDetails,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
  subject: string,
): CompactSummary | undefined {
  switch (details.action) {
    case "start":
      return startSummary(details.snapshot, action);
    case "status":
      return { ...taskReportSummary(details.snapshot), action };
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
      return aggregateSummary(details, args, action, subject);
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
}) =>
  projectBackgroundTaskCompactSummary({
    phase,
    args,
    result: result && { details: result.details },
    isError: context.isError,
  });
