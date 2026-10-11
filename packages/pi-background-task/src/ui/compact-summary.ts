import { exitStatusMeaning } from "pi-code-previews";
import type {
  CompactIssue,
  CompactOutcome,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import {
  clipText,
  countLabel,
  firstLineMessage,
  formatBytes,
  formatDuration,
  quoteText,
  sanitizeTerminalLine,
  stripTerminalControls,
} from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  countTaskStates,
  discardedOutputText,
  failingExitCode,
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

const SEVERITY_ORDER: ReadonlyArray<CompactIssue["severity"]> = ["error", "warning", "info"];

export const backgroundTaskActionLabel = (action: string): string =>
  action === "stop_all" ? "stop all" : sanitizeTerminalLine(String(action));

export const quotedWaitText = (text: string): string =>
  `"${clipText(sanitizeTerminalLine(text), MAX_QUOTED_CHARS)}"`;

const textValue = (value: string | undefined) => (Predicate.isString(value) ? value : "");

function waitSubject(args: Partial<BackgroundTaskToolInput>): string {
  if (args.until === "exit") return "for exit";
  return args.until === "output" && textValue(args.contains)
    ? `for ${quotedWaitText(textValue(args.contains))}`
    : "";
}

export function backgroundTaskCallSubject(args: Partial<BackgroundTaskToolInput>): string {
  switch (args.action) {
    case "start":
      return sanitizeTerminalLine(textValue(args.name).trim() || textValue(args.command));
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
    ["Discarded output cannot be recovered.", detail].filter(Boolean).join(" "),
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
  const { line, detail } = quoteText(stripTerminalControls(error).trim());
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

function failureIssues(value: BackgroundTaskSnapshot, cause: string | undefined): CompactIssue[] {
  const issues: CompactIssue[] = [];
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

function taskOutcome(value: BackgroundTaskSnapshot): CompactOutcome {
  if (value.state === "failed" || value.state === "timed_out" || value.error) return "error";
  if (value.state === "stopped") return "cancelled";
  if (failingExitCode(value) !== undefined || value.signal) return "error";
  if (value.state === "stopping" || (value.state === "exited" && value.exitCode !== 0))
    return "uncertain";
  return "success";
}

function taskIssues(
  value: BackgroundTaskSnapshot,
  outcome: CompactOutcome,
  cause: string | undefined,
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if (value.state === "timed_out")
    issues.push(
      runtimeTimeoutIssue(
        value.id,
        value.endedAt === undefined ? undefined : value.endedAt - value.startedAt,
      ),
    );
  else if (outcome === "error") issues.push(...failureIssues(value, cause));
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

function taskSummary(value: BackgroundTaskSnapshot, cause?: string): TaskSummary {
  const outcome = taskOutcome(value);
  return {
    subject: taskDisplayName(value),
    metadata: [stateDetail(value)],
    outcome,
    issues: taskIssues(value, outcome, cause),
  };
}

function cursorIssues(value: Omit<BackgroundLogMetadata, "state">): CompactIssue[] {
  if (value.droppedBytes <= 0) return [];
  return [
    logLossIssue(
      value.id,
      value.droppedBytes,
      `Retained output starts at cursor ${value.earliestAvailableCursor}; the next read continues after cursor ${value.nextCursor}.`,
    ),
  ];
}

function taskLabels(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const names = tasks.map((task) => clipText(taskDisplayName(task), MAX_TASK_LABEL_CHARS));
  return names.map((name, index) => {
    const same = names.filter((other) => other === name).length;
    if (same === 1) return name;
    return `${name} (${names.slice(0, index + 1).filter((other) => other === name).length})`;
  });
}

function waitTimeoutIssue(
  id: string,
  snapshot: BackgroundTaskSnapshot,
  args: Partial<BackgroundTaskToolInput>,
  appliedWaitSeconds: number | undefined,
): CompactIssue {
  const state = taskStateLabel(snapshot.state);
  const contains = args.until === "output" && Predicate.isString(args.contains) && args.contains;
  const waited = appliedWaitSeconds
    ? `Waited ${formatDuration(appliedWaitSeconds * 1_000)}`
    : "Stopped waiting";
  return issue(
    "warning",
    `${id}:wait-timeout`,
    contains
      ? `${waited} for ${quotedWaitText(contains)}; the task is still ${state}`
      : `${waited} for the task to exit; it is still ${state}`,
    "Wait timed out; this does not stop the background task. Waits end at waitSeconds or the maxWaitSeconds setting, whichever is shorter.",
  );
}

export interface BackgroundTaskCompactSummaryInput {
  readonly phase: CompactPhase;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly result: { details?: unknown; text?: string } | undefined;
  readonly isError: boolean;
}

const causesById = (
  spans: ReadonlyArray<{ readonly id: string; readonly start: number; readonly end: number }>,
  text: string | undefined,
): ReadonlyMap<string, string> =>
  new Map(
    text === undefined
      ? []
      : spans.flatMap(({ id, start, end }) => {
          const cause = end <= text.length && start < end ? text.slice(start, end).trim() : "";
          return cause && !cause.includes("\n") ? [[id, cause] as const] : [];
        }),
  );

type DecodedTaskDetails = typeof BackgroundTaskDetailsSchema.Type;
type DetailsFor<Action extends DecodedTaskDetails["action"]> = Extract<
  DecodedTaskDetails,
  { readonly action: Action }
>;

function aggregateOutcome(tasks: readonly TaskSummary[]): CompactOutcome {
  let outcome: CompactOutcome = "success";
  for (const task of tasks) {
    if (task.outcome === "error") outcome = "error";
    else if (outcome !== "error" && task.outcome === "uncertain") outcome = "uncertain";
    else if (outcome === "success" && task.outcome === "cancelled") outcome = "cancelled";
  }
  return outcome;
}

function aggregateCounters(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const counts = BACKGROUND_TASK_STATES.flatMap((state) => {
    const n = tasks.filter((task) => task.state === state).length;
    return n ? [`${n} ${taskStateLabel(state)}`] : [];
  });
  const total = countLabel(tasks.length, "task");
  const { active, failed } = countTaskStates(tasks);
  const brief = [total, active && `${active} active`, failed && `${failed} failed`]
    .filter(Boolean)
    .join(", ");
  return [...new Set([counts.join(", ") || total, brief, total])];
}

function aggregateSummary(
  details: DetailsFor<"list" | "stop_all">,
  causes: ReadonlyMap<string, string>,
  action: string,
  subject: string,
): CompactSummary {
  const tasks = details.tasks.map((value) => taskSummary(value, causes.get(value.id)));
  const labels = taskLabels(details.tasks);
  const issues = tasks.flatMap((task, index) =>
    task.issues.map((entry) => ({
      ...entry,
      message: firstLineMessage(`${labels[index]}: ${entry.message}`, entry.message),
    })),
  );
  const ordered = SEVERITY_ORDER.flatMap((severity) =>
    issues.filter((entry) => entry.severity === severity),
  );
  return {
    action,
    subject,
    counters: aggregateCounters(details.tasks),
    issues: ordered,
    outcome: aggregateOutcome(tasks),
  };
}

function waitMetadata(wait: DetailsFor<"wait">["wait"], state: string): string {
  if (wait.outcome === "matched") return `output found, ${state}`;
  return wait.outcome === "timeout" ? `still ${taskStateLabel(wait.snapshot.state)}` : state;
}

function waitSummary(
  details: DetailsFor<"wait">,
  causes: ReadonlyMap<string, string>,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
): CompactSummary | undefined {
  const { wait } = details;
  if (wait.id !== wait.snapshot.id) return undefined;
  const task = taskSummary(wait.snapshot, causes.get(wait.snapshot.id));
  const issues = [
    ...task.issues.filter((entry) => entry.code !== `${wait.id}:log-loss`),
    ...cursorIssues(wait),
  ];
  const timeout = wait.outcome === "timeout";
  const applied = details.appliedWaitSeconds;
  if (timeout) issues.unshift(waitTimeoutIssue(wait.id, wait.snapshot, args, applied));
  const state = task.metadata?.[0] ?? taskStateLabel(wait.snapshot.state);
  return {
    ...task,
    action,
    metadata: [waitMetadata(wait, state)],
    issues,
    outcome: timeout && task.outcome === "success" ? "warning" : task.outcome,
    ...(timeout && applied === undefined && { showTiming: true as const }),
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
  const cut = details.truncation;
  if (cut?.truncated)
    issues.push(
      issue(
        "warning",
        `${logs.id}:slice-truncated`,
        `Returned the last ${cut.outputLines} of ${countLabel(cut.totalLines, "log line")}`,
        `The result holds ${formatBytes(cut.outputBytes)} of ${formatBytes(cut.totalBytes)}. Request a smaller log slice with tailLines or afterCursor to read the rest.`,
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
  return issues.some((entry) => entry.severity === "warning") ? "warning" : "success";
}

function logsSummary(details: DetailsFor<"logs">, action: string, subject: string): CompactSummary {
  const issues = logsIssues(details);
  return {
    action,
    subject,
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
  const details = decoded.value;
  const causes = causesById(
    "causes" in details ? (details.causes ?? []) : [],
    Predicate.isString(result?.text) ? result.text : undefined,
  );
  return settledSummary(details, causes, args, action, subject);
};

function settledSummary(
  details: DecodedTaskDetails,
  causes: ReadonlyMap<string, string>,
  args: Partial<BackgroundTaskToolInput>,
  action: string,
  subject: string,
): CompactSummary | undefined {
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return { ...taskSummary(details.snapshot, causes.get(details.snapshot.id)), action };
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
      return aggregateSummary(details, causes, action, subject);
    case "wait":
      return waitSummary(details, causes, args, action);
    case "logs":
      return logsSummary(details, action, subject);
  }
}

export const backgroundTaskCompactSummary: CompactSummaryProvider<
  BackgroundTaskToolInput,
  unknown,
  unknown
> = ({ phase, args, result, context }) => {
  const summary = projectBackgroundTaskCompactSummary({
    phase,
    args,
    result: result && {
      details: result.details,
      text: result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    },
    isError: context.isError,
  });
  return summary && args.action
    ? { ...summary, action: backgroundTaskActionLabel(args.action) }
    : summary;
};
