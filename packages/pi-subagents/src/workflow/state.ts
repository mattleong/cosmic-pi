import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { WorkflowSandboxOutcome } from "../boundary/codemode-sandbox.ts";
import type { WorkflowJournalEntry } from "./journal.ts";
import {
  addWorkflowPhase,
  addWorkflowReusedPhase,
  appendWorkflowLog,
  appendWorkflowWarning,
  isWorkflowRunFinished,
  WORKFLOW_RETAINED_RUNS,
  workflowPhaseTitle,
  type WorkflowAgentView,
  type WorkflowFailure,
  type WorkflowLogEntry,
  type WorkflowResult,
  type WorkflowRunView,
} from "./model.ts";
import type { WorkflowScript } from "./script.ts";

const WorkflowEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("phase"), title: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("log"),
    level: Schema.optional(Schema.Literals(["info", "warning"])),
    message: Schema.String,
  }),
]);
export type WorkflowEvent = typeof WorkflowEventSchema.Type;
/** Script events are best effort: malformed ones are ignored. */
export const decodeWorkflowEvent = Schema.decodeUnknownOption(WorkflowEventSchema);

/** How a run's fiber ended, before it is applied to the view. */
export interface WorkflowConclusion {
  readonly state: "completed" | "failed" | "stopped";
  readonly value?: Schema.Json | undefined;
  readonly failure?: WorkflowFailure | undefined;
  readonly output: ReadonlyArray<string>;
}

/** Adds a log line; a warning is also kept apart, so the log's eviction can't drop it. */
const withLogEntry = (run: WorkflowRunView, entry: WorkflowLogEntry): WorkflowRunView => ({
  ...run,
  logs: appendWorkflowLog(run.logs, entry),
  ...(entry.level === "warning" && {
    warnings: appendWorkflowWarning(run.warnings ?? [], entry),
    warningCount: (run.warningCount ?? 0) + 1,
  }),
});

/** Applies a phase or log event; phases are also added when first seen at runtime. */
export const withWorkflowEvent = (
  run: WorkflowRunView,
  event: WorkflowEvent,
  at: number,
): WorkflowRunView => {
  if (event.type === "log")
    return withLogEntry(run, { at, level: event.level ?? "info", message: event.message });
  const title = workflowPhaseTitle(event.title);
  if (!title) return run;
  return { ...run, phases: addWorkflowPhase(run.phases, title), currentPhase: title };
};

/** Adds a nested workflow's declared phases under its display prefix. */
export const withNestedPhases = (
  run: WorkflowRunView,
  script: WorkflowScript,
  name: string,
): WorkflowRunView => ({
  ...run,
  phases: (script.meta.phases ?? []).reduce(
    (phases, phase) =>
      addWorkflowPhase(phases, workflowPhaseTitle(`▸ ${name} · ${phase.title}`), phase.detail),
    run.phases,
  ),
});

export const withAgent = (run: WorkflowRunView, agent: WorkflowAgentView): WorkflowRunView => ({
  ...run,
  agents: [...run.agents, agent],
  // An agent placed in a new phase also adds that phase.
  phases: agent.phase === undefined ? run.phases : addWorkflowPhase(run.phases, agent.phase),
});

/**
 * Counts a result reused from the resumed run as finished work in the call's display phase. An
 * entry that still names a worktree lists it as a proposal awaiting review; the caller drops the
 * worktree of one already integrated.
 */
export const withReusedResult = (
  run: WorkflowRunView,
  entry: WorkflowJournalEntry,
  phase?: string,
): WorkflowRunView => ({
  ...run,
  reused: run.reused + 1,
  outputTokens: run.outputTokens + entry.outputTokens,
  ...(phase !== undefined && {
    phases: addWorkflowPhase(run.phases, phase),
    reusedPhases: addWorkflowReusedPhase(run.reusedPhases ?? [], phase),
  }),
  ...(entry.workspaceId !== undefined && {
    reusedWorkspaces: [
      ...(run.reusedWorkspaces ?? []),
      { workspaceId: entry.workspaceId, label: entry.label ?? "reused agent" },
    ],
  }),
});

export const withAgentChange = (
  run: WorkflowRunView,
  runId: string,
  change: Partial<WorkflowAgentView>,
): WorkflowRunView => ({
  ...run,
  agents: run.agents.map((agent) => (agent.runId === runId ? { ...agent, ...change } : agent)),
});

const failureOf = (outcome: Extract<WorkflowSandboxOutcome, { _tag: "Failed" }>) =>
  outcome.kind === "timeout" || outcome.kind === "sandbox"
    ? { ...outcome.failure, name: outcome.failure.name ?? "SandboxError" }
    : outcome.failure;

/** Maps the run fiber's exit: interruption means the run was stopped or torn down. */
export const concludeWorkflow = (exit: Exit.Exit<WorkflowSandboxOutcome>): WorkflowConclusion => {
  if (Exit.isSuccess(exit)) {
    const outcome = exit.value;
    if (outcome._tag === "Completed")
      return { state: "completed", value: outcome.value, output: outcome.output };
    if (outcome.kind === "aborted") return { state: "stopped", output: outcome.output };
    return { state: "failed", failure: failureOf(outcome), output: outcome.output };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return { state: "stopped", output: [] };
  const detail = Cause.pretty(exit.cause).trim();
  return {
    state: "failed",
    failure: {
      name: "WorkflowRunnerError",
      message: detail.split("\n")[0] || "The workflow runner failed unexpectedly.",
      ...(detail.includes("\n") && { stack: detail }),
    },
    output: [],
  };
};

/** Records the conclusion; sandbox text output joins the log in order. */
export const finishWorkflowRun = (
  run: WorkflowRunView,
  conclusion: WorkflowConclusion,
  result: WorkflowResult | undefined,
  at: number,
): WorkflowRunView => ({
  ...run,
  state: conclusion.state,
  endedAt: at,
  logs: conclusion.output.reduce(
    (logs, message) => appendWorkflowLog(logs, { at, level: "info", message }),
    run.logs,
  ),
  ...(result && { result }),
  ...(conclusion.failure && { failure: conclusion.failure }),
});

/** Keeps every live run and the newest finished ones. */
export const retainWorkflowRuns = (
  runs: ReadonlyArray<WorkflowRunView>,
): ReadonlyArray<WorkflowRunView> => {
  const finished = runs.filter((run) => isWorkflowRunFinished(run.state));
  if (finished.length <= WORKFLOW_RETAINED_RUNS) return runs;
  const evicted = new Set(
    [...finished]
      .sort((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
      .slice(0, finished.length - WORKFLOW_RETAINED_RUNS)
      .map((run) => run.id),
  );
  return runs.filter((run) => !evicted.has(run.id));
};
