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
  isWorkflowPlannedSkipped,
  isWorkflowRunFinished,
  WORKFLOW_RETAINED_RUNS,
  WORKFLOW_RUN_PLANNED_LIMIT,
  WORKFLOW_SKIPPED_BEFORE_START,
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
/**
 * A line the service logs itself, such as a warning about an agent or the run's files. It is
 * agent-facing, naming run and worktree ids and what to do, so it never becomes the narrator
 * line people read under the workflow; scripts can't send one.
 */
export interface WorkflowServiceLog {
  readonly type: "log";
  readonly level: "info" | "warning";
  readonly message: string;
  readonly narrate: false;
}

export type WorkflowEvent = typeof WorkflowEventSchema.Type | WorkflowServiceLog;
/** Script events are best effort: malformed ones are ignored. */
export const decodeWorkflowEvent = Schema.decodeUnknownOption(WorkflowEventSchema);

export const workflowServiceLog = (
  level: "info" | "warning",
  message: string,
): WorkflowServiceLog => ({ type: "log", level, message, narrate: false });

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

/**
 * Adds a log line, which becomes the narrator line unless `narrate` is false; a warning is also
 * kept apart, so the log's eviction can't drop it.
 */
const withLogEntry = (
  run: WorkflowRunView,
  entry: WorkflowLogEntry,
  narrate = true,
): WorkflowRunView => {
  const lastLog = narrate ? narrated(run, entry.message) : run.lastLog;
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
    return withLogEntry(
      run,
      { at, level: event.level ?? "info", message: event.message },
      !("narrate" in event) || event.narrate,
    );
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
 * display prefix and within the run's limit. Each names the nested workflow, so outside a phase
 * only its calls claim them. A workflow nested again adds none.
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
      return added.has(title) && !shown.has(title)
        ? workflowPlannedAgents(phase, title).map((agent) => ({ ...agent, workflow: name }))
        : [];
    })
    .slice(0, Math.max(0, WORKFLOW_RUN_PLANNED_LIMIT - run.planned.length));
};

/** Adds a nested workflow's declared phases under its display prefix, with their planned agents. */
export const withNestedPhases = (
  run: WorkflowRunView,
  script: WorkflowScript,
  name: string,
  planned: ReadonlyArray<WorkflowPlannedAgent>,
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

/** What an agent() call claims a planned entry by. */
export interface WorkflowPlannedClaim {
  readonly phase?: string | undefined;
  /** The call's own label; without one it shows a claimed entry's label, or agent-<callId>. */
  readonly label?: string | undefined;
  /** The nested workflow() the call was made in, by name; absent for the run's own script. */
  readonly workflow?: string | undefined;
}

/** An agent() call about to be queued, before it has a run id. */
export interface WorkflowAgentDraft extends WorkflowPlannedClaim {
  readonly callId: number;
  readonly queuedAt: number;
  readonly profile?: string | undefined;
}

/**
 * The planned entry an agent() call claims. In a phase, it is the phase's first unclaimed entry
 * with the call's label, or, for a call without a label, the phase's first unclaimed one. Outside
 * any phase, it is the first unclaimed entry with the call's label that the call's own workflow
 * declares, the run's script or the nested workflow() it was made in, and the call takes that
 * entry's phase. An unlabelled call outside any phase, or one whose label matches nothing, claims
 * nothing. Entries the user skipped are claimed like any other.
 */
const claimedIndex = (
  planned: ReadonlyArray<WorkflowPlannedAgent>,
  { phase, label, workflow }: WorkflowPlannedClaim,
): number => {
  if (phase === undefined)
    return label === undefined
      ? -1
      : planned.findIndex((agent) => agent.label === label && agent.workflow === workflow);
  return planned.findIndex(
    (agent) => agent.phase === phase && (label === undefined || agent.label === label),
  );
};

/**
 * Skips the planned entry with `runId` while its run is live and no call has claimed it; skipping
 * it again changes nothing. Returns whether the run holds such an entry.
 */
export const skipWorkflowPlanned = (
  run: WorkflowRunView,
  runId: string,
  at: number,
): readonly [boolean, WorkflowRunView] => {
  const entry = run.planned.find((agent) => agent.runId === runId);
  if (entry === undefined || isWorkflowRunFinished(run.state)) return [false, run];
  if (isWorkflowPlannedSkipped(entry)) return [true, run];
  return [
    true,
    {
      ...run,
      planned: run.planned.map((agent) => (agent === entry ? { ...agent, skippedAt: at } : agent)),
    },
  ];
};

/**
 * Removes the planned entry a call claims when the user skipped it, and returns it with the
 * updated run; a call that would claim no skipped entry changes nothing.
 */
export const claimSkippedWorkflowPlanned = (
  run: WorkflowRunView,
  claim: WorkflowPlannedClaim,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const [claimed, rest] = claimWorkflowPlanned(run, claim);
  return claimed !== undefined && isWorkflowPlannedSkipped(claimed)
    ? [claimed, rest]
    : [undefined, run];
};

/** Removes the planned entry a call claims and returns it with the updated run. */
export const claimWorkflowPlanned = (
  run: WorkflowRunView,
  claim: WorkflowPlannedClaim,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const index = claimedIndex(run.planned, claim);
  const claimed = run.planned[index];
  return claimed
    ? [claimed, { ...run, planned: run.planned.filter((_, position) => position !== index) }]
    : [undefined, run];
};

/**
 * The view of a queued call: a claimed entry's run id, its label where the call gave none, and its
 * phase where the call has none. Planned profiles are display-only and the call runs with its
 * own, so a claimed row shows only the profile the call names, never the planned one. A call that
 * claims an entry the user skipped is settled as skipped from the start.
 */
export const workflowAgentFromDraft = (
  draft: WorkflowAgentDraft,
  runId: string,
  claimed?: WorkflowPlannedAgent,
): WorkflowAgentView => {
  const profile = draft.profile;
  const phase = draft.phase ?? claimed?.phase;
  return {
    callId: draft.callId,
    runId,
    label: draft.label ?? claimed?.label ?? `agent-${draft.callId}`,
    ...(claimed !== undefined && isWorkflowPlannedSkipped(claimed)
      ? { state: "skipped", reason: WORKFLOW_SKIPPED_BEFORE_START, endedAt: draft.queuedAt }
      : { state: "queued" }),
    queuedAt: draft.queuedAt,
    ...(phase !== undefined && { phase }),
    ...(profile !== undefined && { profile }),
  };
};

/**
 * Counts a result reused from the resumed run as finished work in the call's display phase; it
 * costs nothing in this run, so its earlier usage isn't added. An entry that still names a
 * worktree lists it as a proposal awaiting review; the caller drops the worktree of one already
 * integrated.
 */
export const withReusedResult = (
  run: WorkflowRunView,
  entry: WorkflowJournalEntry,
  phase?: string,
): WorkflowRunView => ({
  ...run,
  reused: run.reused + 1,
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
 * which then shows as reused work instead of planned, in the entry's phase when the call has
 * none. Returns the claimed entry.
 */
export const reuseWorkflowResult = (
  run: WorkflowRunView,
  entry: WorkflowJournalEntry,
  claim: WorkflowPlannedClaim,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const [claimed, rest] = claimWorkflowPlanned(run, claim);
  return [claimed, withReusedResult(rest, entry, claim.phase ?? claimed?.phase)];
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
