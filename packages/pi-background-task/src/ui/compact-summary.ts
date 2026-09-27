import { exitStatusMeaning, firstLineMessage } from "pi-code-previews";
import type {
  CompactIssue,
  CompactOutcome,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type {
  BackgroundLogMetadata,
  BackgroundTaskDetailsSnapshot,
  BackgroundTaskSnapshot,
  BackgroundTaskState,
} from "../task/model.ts";
import { BACKGROUND_TASK_STATES, BackgroundTaskDetailsSchema } from "../task/schema.ts";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";

const decodeDetails = Schema.decodeUnknownOption(BackgroundTaskDetailsSchema);
/** Aggregate messages name their task in a short prefix; the raw result keeps full identity. */
const MAX_TASK_LABEL_CHARS = 40;

function compactTaskState(state: BackgroundTaskState): string {
  return state === "timed_out" ? "timed out" : state;
}

const issue = (
  severity: CompactIssue["severity"],
  code: string,
  message: string,
  detail?: string,
): CompactIssue => ({ severity, code, message, ...(detail && { detail }) });

const logLossIssue = (id: string, bytes: number) =>
  issue(
    "warning",
    `${id}:log-loss`,
    "Some task output was discarded",
    `${bytes} log bytes discarded; discarded output cannot be recovered.`,
  );
const cleanupUnconfirmedIssue = (id: string) =>
  issue(
    "warning",
    `${id}:cleanup-unconfirmed`,
    "Some task processes may still be running",
    "Process-tree cleanup is not confirmed; inspect status before retrying work.",
  );
const runtimeTimeoutIssue = (id: string) =>
  issue("error", `${id}:runtime-timeout`, "The task exceeded its time limit");

/** Unclassified task errors keep their full text on expansion when the message is only a part. */
function taskErrorIssue(id: string, error: string): CompactIssue {
  const text = stripTerminalControls(error).trim();
  const message = firstLineMessage(text, "The task reported an error");
  return issue(
    "error",
    `${id}:error`,
    message,
    sanitizeTerminalLine(text) === message ? undefined : text,
  );
}

type TaskSummary = CompactSummary & {
  readonly outcome: CompactOutcome;
  readonly issues: readonly CompactIssue[];
};

function taskSummary(value: BackgroundTaskDetailsSnapshot): TaskSummary {
  const issues: CompactIssue[] = [];
  const nonZeroExit = value.exitCode != null && value.exitCode !== 0;
  let outcome: CompactOutcome = "success";
  if (value.state === "failed" || value.state === "timed_out" || value.error) outcome = "error";
  else if (value.state === "stopped") outcome = "cancelled";
  else if (nonZeroExit || value.signal) outcome = "error";
  else if (value.state === "stopping" || (value.state === "exited" && value.exitCode !== 0))
    outcome = "uncertain";
  if (value.droppedLogBytes > 0) issues.push(logLossIssue(value.id, value.droppedLogBytes));
  if (value.state === "stopping") issues.push(cleanupUnconfirmedIssue(value.id));
  if (value.state === "timed_out") issues.push(runtimeTimeoutIssue(value.id));
  if (outcome === "error") {
    // The captured output line says why; a conventional exit status stands in when none did.
    const exitCause = value.failureLine ?? exitStatusMeaning(value.exitCode);
    if (nonZeroExit)
      issues.push(
        issue(
          "error",
          `${value.id}:exit-code`,
          `The task exited with code ${value.exitCode}${exitCause ? `: ${exitCause}` : ""}`,
        ),
      );
    if (value.signal) {
      const meaning = exitStatusMeaning(undefined, value.signal);
      issues.push(
        issue(
          "error",
          `${value.id}:signal`,
          firstLineMessage(
            `The task received signal ${sanitizeTerminalLine(value.signal)}${meaning ? `: ${meaning}` : ""}`,
            "The task received a signal",
          ),
        ),
      );
    }
    if (
      value.state === "failed" &&
      !value.error &&
      !issues.some((entry) => entry.severity === "error")
    )
      issues.push(
        issue(
          "error",
          `${value.id}:failed`,
          value.failureLine
            ? `The task failed: ${value.failureLine}`
            : "The task failed without reporting a cause",
        ),
      );
  }
  if (value.state === "exited" && value.exitCode == null)
    issues.push(
      issue(
        "warning",
        `${value.id}:exit-unknown`,
        "The task exited, but its outcome is unknown",
        "Process exited, but its exit code is unknown; inspect task status.",
      ),
    );
  if (value.error) issues.push(taskErrorIssue(value.id, value.error));
  const detail =
    value.exitCode == null
      ? compactTaskState(value.state)
      : value.state === "exited"
        ? `exit ${value.exitCode}`
        : `${compactTaskState(value.state)}, exit ${value.exitCode}`;
  const metadata = outcome === "cancelled" ? [] : [detail];
  const subject = sanitizeTerminalLine(value.name?.trim() || value.id);
  return {
    compactSubject: sanitizeTerminalLine(value.name?.trim() || "Background task"),
    subject:
      outcome === "cancelled"
        ? `${subject} stopped${value.signal ? `, signal ${sanitizeTerminalLine(value.signal)}` : ""}`
        : subject,
    metadata,
    outcome,
    issues,
  };
}

function cursorIssues(value: Omit<BackgroundLogMetadata, "state">): CompactIssue[] {
  if (value.droppedBytes <= 0) return [];
  return [
    logLossIssue(value.id, value.droppedBytes),
    issue(
      "info",
      `${value.id}:retained-cursors`,
      "Only recent task output is retained",
      `Retained output: earliest cursor ${value.earliestAvailableCursor}, next cursor ${value.nextCursor}; use logs with afterCursor to continue.`,
    ),
  ];
}

const MAX_DETAIL_CHARS = 2048;

/** The agent-facing detail keeps the exact task identity when it fits the detail bound. */
function withTaskId(id: string, detail: string | undefined): string {
  const labelled = [`Task ${sanitizeTerminalLine(id)}`, detail].filter(Boolean).join("\n");
  return detail === undefined || labelled.length <= MAX_DETAIL_CHARS ? labelled : detail;
}

/**
 * Human labels that keep tasks attributable without internal IDs: a unique name, a numbered
 * name when several share it, or the task's position when it has none.
 */
function taskLabels(tasks: ReadonlyArray<BackgroundTaskSnapshot>): string[] {
  const names = tasks.map((task) => {
    const name = sanitizeTerminalLine(task.name?.trim() ?? "");
    return name.length > MAX_TASK_LABEL_CHARS
      ? `${name.slice(0, MAX_TASK_LABEL_CHARS - 1)}…`
      : name;
  });
  return names.map((name, index) => {
    if (!name) return `Task ${index + 1}`;
    const same = names.filter((other) => other === name).length;
    if (same === 1) return name;
    return `${name} (${names.slice(0, index + 1).filter((other) => other === name).length})`;
  });
}

export interface BackgroundTaskCompactSummaryInput {
  readonly phase: CompactPhase;
  readonly args: Partial<BackgroundTaskToolInput>;
  readonly result: { details?: unknown } | undefined;
  readonly isError: boolean;
}

/** Display-only projection. Unknown errors keep their original text on expansion. */
export const projectBackgroundTaskCompactSummary = ({
  phase,
  args,
  result,
  isError,
}: BackgroundTaskCompactSummaryInput): CompactSummary | undefined => {
  const action = args.action ?? "task";
  const subject =
    args.action === "start"
      ? sanitizeTerminalLine(args.name?.trim() || args.command || "")
      : "id" in args && Predicate.isString(args.id)
        ? sanitizeTerminalLine(args.id)
        : "";
  if (phase !== "settled")
    return { action, subject, ...(args.action !== "start" && { compactSubject: "" }) };
  if (isError) return undefined;
  const decoded = decodeDetails(result?.details);
  if (Option.isNone(decoded)) return undefined;
  const details = decoded.value;
  if (details.action !== args.action) return undefined;
  switch (details.action) {
    case "start":
    case "status":
    case "stop":
      return { ...taskSummary(details.snapshot), action };
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
      const tasks = details.tasks.map(taskSummary);
      const labels = taskLabels(details.tasks);
      const counters: string[] = [`${tasks.length} tasks`];
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
            detail: withTaskId(details.tasks[index]!.id, entry.detail),
          })),
        );
      }
      for (const state of BACKGROUND_TASK_STATES) {
        const n = details.tasks.filter((task) => task.state === state).length;
        if (n) counters.push(`${n} ${compactTaskState(state)}`);
      }
      if (counters.length > 1) counters.shift();
      return { action, subject, counters: [counters.join(", ")], issues, outcome };
    }
    case "wait": {
      const task = taskSummary(details.wait.snapshot);
      if (details.wait.id !== details.wait.snapshot.id) return undefined;
      const issues = [...task.issues, ...cursorIssues(details.wait)];
      const timeout = details.wait.outcome === "timeout";
      if (timeout)
        issues.push(
          issue(
            "warning",
            `${details.wait.id}:wait-timeout`,
            "Timed out waiting; the task may still be running",
            "Wait timed out; this does not stop the background task.",
          ),
        );
      const completedExit =
        details.wait.outcome === "completed" &&
        details.wait.snapshot.state === "exited" &&
        details.wait.snapshot.exitCode != null;
      return {
        ...task,
        action,
        metadata: completedExit
          ? (task.metadata ?? [])
          : [[details.wait.outcome, ...(task.metadata ?? [])].join(", ")],
        issues,
        outcome: timeout && task.outcome === "success" ? "warning" : task.outcome,
      };
    }
    case "logs": {
      const logs = details.logs;
      const issues = cursorIssues(logs);
      const cut = details.truncation;
      if (cut?.truncated)
        issues.push(
          issue(
            "warning",
            `${logs.id}:slice-truncated`,
            "Only part of the requested logs was returned",
            `Output truncated: ${cut.outputLines}/${cut.totalLines} lines, ${cut.outputBytes}/${cut.totalBytes} bytes.`,
          ),
          issue(
            "info",
            `${logs.id}:request-log-slice`,
            "Expansion shows only the fetched output",
            "Request a smaller log slice; expansion shows only fetched output.",
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
      if (logs.state === "failed" || logs.state === "timed_out")
        issues.push(
          logs.state === "timed_out"
            ? runtimeTimeoutIssue(logs.id)
            : issue("error", `${logs.id}:failed`, "The task failed"),
          issue(
            "info",
            `${logs.id}:read-task-status`,
            "Task status has the failure details",
            "Read task status for the failure cause and details.",
          ),
        );
      if (logs.state === "stopping") issues.push(cleanupUnconfirmedIssue(logs.id));
      return {
        action,
        subject: sanitizeTerminalLine(logs.id),
        compactSubject: "Task logs",
        metadata: [compactTaskState(logs.state)],
        outcome,
        issues,
      };
    }
    default:
      return undefined;
  }
};

export const backgroundTaskCompactSummary: CompactSummaryProvider<
  BackgroundTaskToolInput,
  unknown,
  unknown
> = ({ phase, args, result, context }) =>
  projectBackgroundTaskCompactSummary({ phase, args, result, isError: context.isError });
