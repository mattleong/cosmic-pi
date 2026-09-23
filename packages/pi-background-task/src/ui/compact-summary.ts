import { withCompactIssues } from "pi-code-previews";
import type {
  CompactNotice,
  CompactOutcome,
  CompactSummary,
  CompactSummaryProvider,
} from "pi-code-previews";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { BackgroundTaskToolInput } from "../tools/schema.ts";

const states = [
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
  "stopped",
  "timed_out",
] as const;
const State = Schema.Literals(states);
const Text = Schema.String.check(Schema.isMaxLength(8192));
const Snapshot = Schema.Struct({
  id: Text,
  name: Schema.optionalKey(Text),
  command: Text,
  cwd: Text,
  state: State,
  startedAt: Schema.Natural,
  logCursor: Schema.Natural,
  droppedLogBytes: Schema.Natural,
  exitCode: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  signal: Schema.optionalKey(Text),
  error: Schema.optionalKey(Text),
});
const cursorFields = {
  nextCursor: Schema.Natural,
  earliestAvailableCursor: Schema.Natural,
  droppedBytes: Schema.Natural,
};
const Cursors = Schema.Struct(cursorFields);
// These are display projections of BackgroundTaskToolDetails, without defaults or output text.
const Details = Schema.Union([
  Schema.Struct({ action: Schema.Literals(["start", "status", "stop"]), snapshot: Snapshot }),
  Schema.Struct({
    action: Schema.Literals(["list", "stop_all"]),
    tasks: Schema.Array(Snapshot).check(Schema.isMaxLength(600)),
  }),
  Schema.Struct({ action: Schema.Literal("clear"), removed: Schema.Natural }),
  Schema.Struct({
    action: Schema.Literal("wait"),
    wait: Schema.Struct({
      id: Text,
      outcome: Schema.Literals(["matched", "completed", "timeout"]),
      snapshot: Snapshot,
      ...cursorFields,
    }),
  }),
  Schema.Struct({
    action: Schema.Literal("logs"),
    logs: Schema.Struct({ id: Text, state: State, ...cursorFields }),
    truncation: Schema.optionalKey(
      Schema.Struct({
        truncated: Schema.Boolean,
        outputBytes: Schema.Natural,
        totalBytes: Schema.Natural,
        outputLines: Schema.Natural,
        totalLines: Schema.Natural,
      }),
    ),
  }),
]);

function compactTaskState(state: typeof State.Type): string {
  return state === "timed_out" ? "timed out" : state;
}

function taskSummary(value: typeof Snapshot.Type): CompactSummary & { outcome: CompactOutcome } {
  const notices: CompactNotice[] = [];
  let outcome: CompactOutcome = "success";
  if (value.state === "failed" || value.state === "timed_out" || value.error) outcome = "error";
  else if (value.state === "stopped") outcome = "cancelled";
  else if (
    (value.exitCode !== undefined && value.exitCode !== null && value.exitCode !== 0) ||
    value.signal
  )
    outcome = "error";
  else if (value.state === "stopping" || (value.state === "exited" && value.exitCode !== 0))
    outcome = "uncertain";
  if (value.droppedLogBytes > 0)
    notices.push({
      code: `${value.id}:log-loss`,
      description: "Some task output was discarded and cannot be recovered.",
      kind: "warning",
      text: `${value.droppedLogBytes} log bytes discarded; discarded output cannot be recovered.`,
    });
  if (value.state === "stopping")
    notices.push({
      code: `${value.id}:cleanup-unconfirmed`,
      description: "Some task processes may still be running.",
      kind: "recovery",
      text: "Process-tree cleanup is not confirmed; inspect status before retrying work.",
    });
  if (value.state === "timed_out")
    notices.push({
      code: `${value.id}:runtime-timeout`,
      description: "The task exceeded its time limit.",
      kind: "error",
      text: "Task exceeded its runtime timeout.",
    });
  if (outcome === "error") {
    if (value.exitCode !== undefined && value.exitCode !== null && value.exitCode !== 0)
      notices.push({
        code: `${value.id}:exit-code`,
        description: `The task exited with code ${value.exitCode}.`,
        kind: "error",
        text: `Process exited with code ${value.exitCode}.`,
      });
    if (value.signal)
      notices.push({
        code: `${value.id}:signal`,
        description: "The task received a signal.",
        kind: "error",
        text: `Process received signal ${sanitizeTerminalLine(value.signal)}.`,
      });
    if (
      value.state === "failed" &&
      !value.error &&
      !notices.some((notice) => notice.kind === "error")
    )
      notices.push({
        code: `${value.id}:failed`,
        description: "The task failed without reporting a cause.",
        kind: "error",
        text: "Task failed; no failure cause was reported.",
      });
  }
  if (value.state === "exited" && value.exitCode == null)
    notices.push({
      code: `${value.id}:exit-unknown`,
      description: "The task exited, but its outcome is unknown.",
      kind: "recovery",
      text: "Process exited, but its exit code is unknown; inspect task status.",
    });
  if (value.error)
    notices.push({
      kind: "error",
      text: sanitizeTerminalLine(value.error),
      description: "The task reported an error.",
    });
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
    notices,
    detailsOnExpand: true,
  };
}

function cursors(value: typeof Cursors.Type, notices: CompactNotice[], id: string): void {
  if (value.droppedBytes > 0)
    notices.push({
      code: `${id}:log-loss`,
      description: "Some task output was discarded and cannot be recovered.",
      kind: "warning",
      text: `${value.droppedBytes} log bytes discarded; discarded output cannot be recovered.`,
    });
  if (value.droppedBytes > 0)
    notices.push({
      code: `${id}:retained-cursors`,
      kind: "recovery",
      text: `Retained output: earliest cursor ${value.earliestAvailableCursor}, next cursor ${value.nextCursor}; use logs with afterCursor to continue.`,
    });
}

/** Display-only projection. Unknown errors keep their original text, including cleanup guidance. */
const projectTaskSummary = ({
  phase,
  args,
  result,
  isError,
}: {
  phase: "pending" | "running" | "settled";
  args: Partial<BackgroundTaskToolInput>;
  result: { details?: unknown } | undefined;
  isError: boolean;
}): import("pi-code-previews").CompactSummary | undefined => {
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
  const decoded = Schema.decodeUnknownOption(Details)(result?.details);
  if (Option.isNone(decoded)) return undefined;
  const details = decoded.value;
  if (details.action !== args.action) return undefined;
  switch (details.action) {
    case "start":
    case "status":
    case "stop": {
      const task = taskSummary(details.snapshot);
      return { ...task, action };
    }
    case "clear":
      return {
        action,
        subject,
        counters: [`${details.removed} removed`],
        outcome: "success",
        detailsOnExpand: true,
      };
    case "list":
    case "stop_all": {
      const tasks = details.tasks.map(taskSummary);
      const counters: string[] = [`${tasks.length} tasks`];
      const notices: CompactNotice[] = [];
      let outcome: CompactOutcome = "success";
      for (const [index, task] of tasks.entries()) {
        const taskId = details.tasks[index]!.id;
        if (task.outcome === "error") outcome = "error";
        else if (outcome !== "error" && task.outcome === "uncertain") outcome = "uncertain";
        else if (outcome === "success" && task.outcome === "cancelled") outcome = "cancelled";
        notices.push(
          ...(task.notices ?? []).map((notice) => ({
            ...notice,
            text: `${taskId}: ${notice.text}`,
            ...(notice.description && {
              description: `${taskId.slice(0, 60)}: ${notice.description}`,
            }),
          })),
        );
      }
      for (const state of states) {
        const n = details.tasks.filter((task) => task.state === state).length;
        if (n) counters.push(`${n} ${compactTaskState(state)}`);
      }
      if (counters.length > 1) counters.shift();
      return {
        action,
        subject,
        counters: [counters.join(", ")],
        notices,
        outcome,
        detailsOnExpand: true,
      };
    }
    case "wait": {
      const task = taskSummary(details.wait.snapshot);
      if (details.wait.id !== details.wait.snapshot.id) return undefined;
      const notices = [...(task.notices ?? [])];
      cursors(details.wait, notices, details.wait.id);
      const timeout = details.wait.outcome === "timeout";
      if (timeout)
        notices.push({
          code: `${details.wait.id}:wait-timeout`,
          description: "Timed out waiting. The task may still be running.",
          kind: "warning",
          text: "Wait timed out; this does not stop the background task.",
        });
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
        notices,
        outcome: timeout && task.outcome === "success" ? "warning" : task.outcome,
      };
    }
    case "logs": {
      const logs = details.logs;
      const notices: CompactNotice[] = [];
      cursors(logs, notices, logs.id);
      if (details.truncation !== undefined) {
        const cut = details.truncation;
        if (cut.truncated)
          notices.push(
            {
              code: `${logs.id}:slice-truncated`,
              description: "Only part of the requested logs was returned.",
              kind: "warning",
              text: `Output truncated: ${cut.outputLines}/${cut.totalLines} lines, ${cut.outputBytes}/${cut.totalBytes} bytes.`,
            },
            {
              code: `${logs.id}:request-log-slice`,
              kind: "recovery",
              text: "Request a smaller log slice; expansion shows only fetched output.",
            },
          );
      }
      // Success here describes log retrieval, not a clean process exit. Log slices omit
      // exit codes by contract; snapshot-based status checks still classify exit evidence.
      const outcome: CompactOutcome =
        logs.state === "failed" || logs.state === "timed_out"
          ? "error"
          : logs.state === "stopped"
            ? "cancelled"
            : logs.state === "stopping"
              ? "uncertain"
              : notices.some((n) => n.kind === "warning")
                ? "warning"
                : "success";
      if (logs.state === "failed" || logs.state === "timed_out")
        notices.push(
          {
            code: `${logs.id}:${logs.state === "timed_out" ? "runtime-timeout" : "failed"}`,
            description:
              logs.state === "timed_out" ? "The task exceeded its time limit." : "The task failed.",
            kind: "error",
            text:
              logs.state === "timed_out" ? "Task exceeded its runtime timeout." : "Task failed.",
          },
          {
            code: `${logs.id}:read-task-status`,
            kind: "recovery",
            text: "Read task status for the failure cause and details.",
          },
        );
      if (logs.state === "stopping")
        notices.push({
          code: `${logs.id}:cleanup-unconfirmed`,
          description: "Some task processes may still be running.",
          kind: "recovery",
          text: "Process-tree cleanup is not confirmed; inspect status before retrying work.",
        });
      return {
        action,
        subject: sanitizeTerminalLine(logs.id),
        compactSubject: "Task logs",
        metadata: [compactTaskState(logs.state)],
        outcome,
        notices,
        detailsOnExpand: true,
      };
    }
    default:
      return undefined;
  }
};

export const projectBackgroundTaskCompactSummary = (
  input: Parameters<typeof projectTaskSummary>[0],
) => {
  const summary = projectTaskSummary(input);
  return summary
    ? withCompactIssues(summary, `background-task:${input.args.action ?? "task"}`)
    : undefined;
};

export const backgroundTaskCompactSummary: CompactSummaryProvider<
  BackgroundTaskToolInput,
  unknown,
  unknown
> = ({ phase, args, result, context }) =>
  projectBackgroundTaskCompactSummary({ phase, args, result, isError: context.isError });
