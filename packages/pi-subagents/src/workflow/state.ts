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
  WORKFLOW_RUN_PLANNED_LIMIT,
  workflowNarratorLine,
  workflowPhaseTitle,
  type WorkflowAgentView,
  type WorkflowFailure,
  type WorkflowLogEntry,
  type WorkflowPlannedAgent,
  type WorkflowResult,
  type WorkflowRunView,
} from "./model.ts";
import {
  workflowPlannedAgents,
  type WorkflowPlannedAgentSpec,
  type WorkflowScript,
} from "./script.ts";

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

/** The narrator line after `message`; a blank line keeps the previous one. */
const narrated = (run: WorkflowRunView, message: string): string | undefined =>
  workflowNarratorLine(message) ?? run.lastLog;

/** Adds a log line; a warning is also kept apart, so the log's eviction can't drop it. */
const withLogEntry = (run: WorkflowRunView, entry: WorkflowLogEntry): WorkflowRunView => {
  const lastLog = narrated(run, entry.message);
  return {
    ...run,
    logs: appendWorkflowLog(run.logs, entry),
    ...(lastLog !== undefined && { lastLog }),
    ...(entry.level === "warning" && {
      warnings: appendWorkflowWarning(run.warnings ?? [], entry),
      warningCount: (run.warningCount ?? 0) + 1,
    }),
  };
};

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

const nestedPhaseTitle = (name: string, title: string): string =>
  workflowPhaseTitle(`▸ ${name} · ${title}`);

const nestedPhases = (run: WorkflowRunView, script: WorkflowScript, name: string) =>
  (script.meta.phases ?? []).reduce(
    (phases, phase) => addWorkflowPhase(phases, nestedPhaseTitle(name, phase.title), phase.detail),
    run.phases,
  );

/**
 * The planned agents of a nested workflow's phases that this run doesn't show yet, under their
 * display prefix and within the run's limit. A workflow nested again adds none.
 */
export const nestedWorkflowPlanned = (
  run: WorkflowRunView,
  script: WorkflowScript,
  name: string,
): ReadonlyArray<WorkflowPlannedAgentSpec> => {
  const shown = new Set(run.phases.map((phase) => phase.title));
  const added = new Set(nestedPhases(run, script, name).map((phase) => phase.title));
  return (script.meta.phases ?? [])
    .flatMap((phase) => {
      const title = nestedPhaseTitle(name, phase.title);
      return added.has(title) && !shown.has(title) ? workflowPlannedAgents(phase, title) : [];
    })
    .slice(0, Math.max(0, WORKFLOW_RUN_PLANNED_LIMIT - run.planned.length));
};

/** Adds a nested workflow's declared phases under its display prefix, with their planned agents. */
export const withNestedPhases = (
  run: WorkflowRunView,
  script: WorkflowScript,
  name: string,
  planned: ReadonlyArray<WorkflowPlannedAgent> = [],
): WorkflowRunView => ({
  ...run,
  phases: nestedPhases(run, script, name),
  planned: [...run.planned, ...planned],
});

export const withAgent = (run: WorkflowRunView, agent: WorkflowAgentView): WorkflowRunView => ({
  ...run,
  agents: [...run.agents, agent],
  // An agent placed in a new phase also adds that phase.
  phases: agent.phase === undefined ? run.phases : addWorkflowPhase(run.phases, agent.phase),
});

/** An agent() call about to be queued, before it has a run id. */
export interface WorkflowAgentDraft {
  readonly callId: number;
  readonly queuedAt: number;
  /** The call's own label; without one it shows a claimed entry's label, or agent-<callId>. */
  readonly label?: string | undefined;
  readonly phase?: string | undefined;
  readonly profile?: string | undefined;
}

/**
 * The planned entry an agent() call in `phase` claims: the first unclaimed one with its label,
 * or, for a call without a label, the phase's first unclaimed one. A call outside any phase, or
 * whose label matches nothing, claims nothing.
 */
const claimedIndex = (
  planned: ReadonlyArray<WorkflowPlannedAgent>,
  phase: string | undefined,
  label: string | undefined,
): number => {
  if (phase === undefined) return -1;
  return planned.findIndex(
    (agent) => agent.phase === phase && (label === undefined || agent.label === label),
  );
};

/** Removes the planned entry a call claims and returns it with the updated run. */
export const claimWorkflowPlanned = (
  run: WorkflowRunView,
  phase: string | undefined,
  label: string | undefined,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const index = claimedIndex(run.planned, phase, label);
  const claimed = run.planned[index];
  return claimed
    ? [claimed, { ...run, planned: run.planned.filter((_, position) => position !== index) }]
    : [undefined, run];
};

/**
 * The view of a queued call: a claimed entry's run id, and its label where the call gave none.
 * Planned profiles are display-only and the call runs with its own, so a claimed row shows only
 * the profile the call names, never the planned one.
 */
export const workflowAgentFromDraft = (
  draft: WorkflowAgentDraft,
  runId: string,
  claimed?: WorkflowPlannedAgent,
): WorkflowAgentView => {
  const profile = draft.profile;
  return {
    callId: draft.callId,
    runId,
    label: draft.label ?? claimed?.label ?? `agent-${draft.callId}`,
    state: "queued",
    queuedAt: draft.queuedAt,
    ...(draft.phase !== undefined && { phase: draft.phase }),
    ...(profile !== undefined && { profile }),
  };
};

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

/**
 * Counts a reused result like {@link withReusedResult}; the call also claims its planned entry,
 * which then shows as reused work instead of planned. Returns the claimed entry.
 */
export const reuseWorkflowResult = (
  run: WorkflowRunView,
  entry: WorkflowJournalEntry,
  phase: string | undefined,
  label: string | undefined,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const [claimed, rest] = claimWorkflowPlanned(run, phase, label);
  return [claimed, withReusedResult(rest, entry, phase)];
};

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
): WorkflowRunView => {
  const lastLog = conclusion.output.reduce(
    (line: string | undefined, message) => workflowNarratorLine(message) ?? line,
    run.lastLog,
  );
  return {
    ...run,
    state: conclusion.state,
    endedAt: at,
    logs: conclusion.output.reduce(
      (logs, message) => appendWorkflowLog(logs, { at, level: "info", message }),
      run.logs,
    ),
    ...(lastLog !== undefined && { lastLog }),
    ...(result && { result }),
    ...(conclusion.failure && { failure: conclusion.failure }),
  };
};

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
