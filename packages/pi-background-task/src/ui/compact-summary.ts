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
  type BackgroundLogMetadata,
  type BackgroundTaskSnapshot,
} from "../task/model.ts";
import { BACKGROUND_TASK_STATES, BackgroundTaskDetailsSchema } from "../task/schema.ts";
import type { BackgroundTaskToolDetails } from "../tools/command.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";
import { taskDisplayName, taskStateLabel } from "./task-state.ts";

/** Persisted details decoded with the shared task schema; anything else is None. */
export const decodeBackgroundTaskDetails = Schema.decodeUnknownOption(BackgroundTaskDetailsSchema);

/** Aggregate messages name their task in a short prefix; the raw result keeps full identity. */
const MAX_TASK_LABEL_CHARS = 40;
/** A wait's literal text as headings and messages quote it. */
const MAX_QUOTED_CHARS = 40;

type Action = BackgroundTaskToolInput["action"];

const SEVERITY_ORDER: ReadonlyArray<CompactIssue["severity"]> = ["error", "warning", "info"];

const ACTION_LABELS = {
  start: "start",
  list: "list",
  status: "status",
  logs: "logs",
  wait: "wait",
  stop: "stop",
  stop_all: "stop all",
  clear: "clear",
} as const satisfies Record<Action, string>;

/**
 * An action as people read it: `stop_all` is "stop all". Foreign arguments can name any action,
 * so only own keys count; `constructor` must not resolve to `Object.prototype`'s.
 */
export const backgroundTaskActionLabel = (action: Action): string =>
  Object.hasOwn(ACTION_LABELS, action)
    ? ACTION_LABELS[action]
    : sanitizeTerminalLine(String(action));

/** Literal text a wait matches, quoted and bounded for one row. */
export const quotedWaitText = (text: string): string =>
  `"${clipText(sanitizeTerminalLine(text), MAX_QUOTED_CHARS)}"`;

/**
 * What a call names before its result: a start's name or command, what a wait awaits, a list's
 * filter. Task IDs are never a subject; the settled result names the task.
 */
export function backgroundTaskCallSubject(args: Partial<BackgroundTaskToolInput>): string {
  const text = (value: string | undefined) => (Predicate.isString(value) ? value : "");
  switch (args.action) {
    case "start":
      return sanitizeTerminalLine(text(args.name).trim() || text(args.command));
    case "wait":
      if (args.until === "exit") return "for exit";
      return args.until === "output" && text(args.contains)
        ? `for ${quotedWaitText(text(args.contains))}`
        : "";
    case "list":
      return args.state === "active" || args.state === "completed" ? args.state : "";
    default:
      return "";
  }
}

/** The task a settled result is about, by name or command; empty when the details name none. */
export function backgroundTaskResultSubject(
  details: BackgroundTaskToolDetails,
  args: Partial<BackgroundTaskToolInput>,
): string {
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return taskDisplayName(details.snapshot);
    case "wait":
      return taskDisplayName(details.wait.snapshot);
    case "list":
      return backgroundTaskCallSubject(args);
    default:
      return "";
  }
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
/** The task's runtime limit ended it; how long it ran, when known, is the fact people need. */
const runtimeTimeoutIssue = (id: string, ranMs: number | undefined, detail?: string) =>
  issue(
    "error",
    `${id}:runtime-timeout`,
    ranMs === undefined ? "Timed out" : `Timed out after ${formatDuration(ranMs)}`,
    detail,
  );

/** Unclassified task errors keep their full text on expansion when the message is only a part. */
function taskErrorIssue(id: string, error: string): CompactIssue {
  const { line, detail } = quoteText(stripTerminalControls(error).trim());
  return issue("error", `${id}:error`, line ?? "Reported an error", detail);
}

type TaskSummary = CompactSummary & {
  readonly outcome: CompactOutcome;
  readonly issues: readonly CompactIssue[];
};

/** A state word, with the exit code when it is not a clean one: "failed, exit 1", "finished". */
function stateDetail(value: BackgroundTaskSnapshot): string {
  const label = taskStateLabel(value.state);
  const endedByUs = value.state === "timed_out" || value.state === "stopped";
  return value.exitCode != null && value.exitCode !== 0 && !endedByUs
    ? `${label}, exit ${value.exitCode}`
    : label;
}

/**
 * Why a failed task failed: its exit code or signal, with the captured cause or its meaning. The
 * row names the task, so messages start with what happened, as bash's do.
 */
function failureIssues(value: BackgroundTaskSnapshot, cause: string | undefined): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if (value.exitCode != null && value.exitCode !== 0) {
    // The captured output line says why; a conventional exit status stands in when none did.
    const exitCause = cause ?? exitStatusMeaning(value.exitCode);
    issues.push(
      issue(
        "error",
        `${value.id}:exit-code`,
        `Exited with code ${value.exitCode}${exitCause ? `: ${exitCause}` : ""}`,
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

function taskSummary(value: BackgroundTaskSnapshot, cause?: string): TaskSummary {
  const nonZeroExit = value.exitCode != null && value.exitCode !== 0;
  let outcome: CompactOutcome = "success";
  if (value.state === "failed" || value.state === "timed_out" || value.error) outcome = "error";
  else if (value.state === "stopped") outcome = "cancelled";
  else if (nonZeroExit || value.signal) outcome = "error";
  else if (value.state === "stopping" || (value.state === "exited" && value.exitCode !== 0))
    outcome = "uncertain";
  const issues: CompactIssue[] = [];
  // The time limit explains a timed-out task; the signal that ended it is ours, not a cause.
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
  if (value.state === "exited" && value.exitCode == null && !value.signal)
    issues.push(
      issue(
        "warning",
        `${value.id}:exit-unknown`,
        "Exited, but its outcome is unknown",
        "Process exited, but its exit code is unknown; inspect task status.",
      ),
    );
  if (value.droppedLogBytes > 0) issues.push(logLossIssue(value.id, value.droppedLogBytes));
  return { subject: taskDisplayName(value), metadata: [stateDetail(value)], outcome, issues };
}

/** Lost output as a log read or wait reports it, with where the retained output resumes. */
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

/**
 * Human labels that keep tasks attributable without internal IDs: a unique name or command, a
 * numbered one when several share it.
 */
function taskLabels(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const names = tasks.map((task) => clipText(taskDisplayName(task), MAX_TASK_LABEL_CHARS));
  return names.map((name, index) => {
    const same = names.filter((other) => other === name).length;
    if (same === 1) return name;
    return `${name} (${names.slice(0, index + 1).filter((other) => other === name).length})`;
  });
}

/**
 * How long a timed-out wait lasted and what it awaited. The time is the wait the service applied,
 * never the requested `waitSeconds`, which the `maxWaitSeconds` setting can shorten. Older details
 * without it leave elapsed time to the shell's measured timing.
 */
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
  /** `text` is the result text that the details' cause spans point into. */
  readonly result: { details?: unknown; text?: string } | undefined;
  readonly isError: boolean;
}

/** Each failed task's cause, read from the result text at its producer-recorded span. */
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

/** Display-only projection. Unknown errors keep their original text on expansion. */
export const projectBackgroundTaskCompactSummary = ({
  phase,
  args,
  result,
  isError,
}: BackgroundTaskCompactSummaryInput): CompactSummary | undefined => {
  const action = args.action ?? "task";
  const subject = backgroundTaskCallSubject(args);
  if (phase !== "settled") return { action, subject };
  // A rejected call carries only its message; the shell explains the error from it.
  if (isError) return { action, subject, outcome: "error", issues: [] };
  const decoded = decodeBackgroundTaskDetails(result?.details);
  if (Option.isNone(decoded)) return undefined;
  const details = decoded.value;
  if (details.action !== args.action) return undefined;
  const causes = causesById(
    "causes" in details ? (details.causes ?? []) : [],
    Predicate.isString(result?.text) ? result.text : undefined,
  );
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
    case "stop_all": {
      const tasks = details.tasks.map((value) => taskSummary(value, causes.get(value.id)));
      const labels = taskLabels(details.tasks);
      const issues: CompactIssue[] = [];
      let outcome: CompactOutcome = "success";
      for (const [index, task] of tasks.entries()) {
        if (task.outcome === "error") outcome = "error";
        else if (outcome !== "error" && task.outcome === "uncertain") outcome = "uncertain";
        else if (outcome === "success" && task.outcome === "cancelled") outcome = "cancelled";
        issues.push(
          ...task.issues.map((entry) => ({
            ...entry,
            message: firstLineMessage(`${labels[index]}: ${entry.message}`, entry.message),
          })),
        );
      }
      const counts = BACKGROUND_TASK_STATES.flatMap((state) => {
        const n = details.tasks.filter((task) => task.state === state).length;
        return n ? [`${n} ${taskStateLabel(state)}`] : [];
      });
      // Every state count first; narrower rows fall back to the total with what needs attention.
      const total = countLabel(details.tasks.length, "task");
      const { active, failed } = countTaskStates(details.tasks);
      const brief = [total, active && `${active} active`, failed && `${failed} failed`]
        .filter(Boolean)
        .join(", ");
      const counters = [...new Set([counts.join(", ") || total, brief, total])];
      // Failures lead; each severity keeps the tasks' order.
      const ordered = SEVERITY_ORDER.flatMap((severity) =>
        issues.filter((entry) => entry.severity === severity),
      );
      return { action, subject, counters, issues: ordered, outcome };
    }
    case "wait": {
      const { wait } = details;
      if (wait.id !== wait.snapshot.id) return undefined;
      const task = taskSummary(wait.snapshot, causes.get(wait.snapshot.id));
      // The wait's cursors say where retained output resumes; its loss replaces the snapshot's.
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
        metadata: [
          wait.outcome === "matched"
            ? `output found, ${state}`
            : timeout
              ? `still ${taskStateLabel(wait.snapshot.state)}`
              : state,
        ],
        issues,
        outcome: timeout && task.outcome === "success" ? "warning" : task.outcome,
        // Without the applied wait, the measured call time says how long a timed-out wait lasted.
        ...(timeout && applied === undefined && { showTiming: true as const }),
      };
    }
    case "logs": {
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
        issues.push(
          runtimeTimeoutIssue(logs.id, undefined, "Read task status for how long it ran."),
        );
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
      // Success here describes log retrieval, not a clean process exit. Log slices omit
      // exit codes by contract; snapshot-based status checks still classify exit evidence.
      const outcome: CompactOutcome =
        logs.state === "failed" || logs.state === "timed_out"
          ? "error"
          : logs.state === "stopped"
            ? "cancelled"
            : logs.state === "stopping"
              ? "uncertain"
              : issues.some((entry) => entry.severity === "warning")
                ? "warning"
                : "success";
      return { action, subject, metadata: [taskStateLabel(logs.state)], outcome, issues };
    }
    default:
      return undefined;
  }
};

/** The shell's provider: the shared projection, with the action as people read it. */
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
