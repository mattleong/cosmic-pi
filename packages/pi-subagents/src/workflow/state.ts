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
interface WorkflowServiceLog {
  readonly type: "log";
  readonly level: "info" | "warning";
  readonly message: string;
  readonly narrate: false;
}

export type WorkflowEvent = typeof WorkflowEventSchema.Type | WorkflowServiceLog;
export const decodeWorkflowEvent = Schema.decodeUnknownOption(WorkflowEventSchema);

export const workflowServiceLog = (
  level: "info" | "warning",
  message: string,
): WorkflowServiceLog => ({ type: "log", level, message, narrate: false });

interface WorkflowConclusion {
  readonly state: "completed" | "failed" | "stopped";
  readonly value?: Schema.Json | undefined;
  readonly failure?: WorkflowFailure | undefined;
  readonly output: ReadonlyArray<string>;
}

const withLogEntry = (
  run: WorkflowRunView,
  entry: WorkflowLogEntry,
  narrate = true,
): WorkflowRunView => {
  const lastLog = narrate ? (workflowNarratorLine(entry.message) ?? run.lastLog) : run.lastLog;
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
        ? workflowPlannedAgents(phase, title).map((agent) =>
            Object.assign({}, agent, { workflow: name }),
          )
        : [];
    })
    .slice(0, Math.max(0, WORKFLOW_RUN_PLANNED_LIMIT - run.planned.length));
};

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
  phases: agent.phase === undefined ? run.phases : addWorkflowPhase(run.phases, agent.phase),
});

export interface WorkflowPlannedClaim {
  readonly phase?: string | undefined;
  readonly label?: string | undefined;
  readonly workflow?: string | undefined;
}

export interface WorkflowAgentDraft extends WorkflowPlannedClaim {
  readonly callId: number;
  readonly queuedAt: number;
  readonly profile?: string | undefined;
}

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

export const claimSkippedWorkflowPlanned = (
  run: WorkflowRunView,
  claim: WorkflowPlannedClaim,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const [claimed, rest] = claimWorkflowPlanned(run, claim);
  return claimed !== undefined && isWorkflowPlannedSkipped(claimed)
    ? [claimed, rest]
    : [undefined, run];
};

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

export const reuseWorkflowResult = (
  run: WorkflowRunView,
  entry: WorkflowJournalEntry,
  claim: WorkflowPlannedClaim,
): readonly [WorkflowPlannedAgent | undefined, WorkflowRunView] => {
  const [claimed, rest] = claimWorkflowPlanned(run, claim);
  const phase = claim.phase ?? claimed?.phase;
  return [
    claimed,
    {
      ...rest,
      reused: rest.reused + 1,
      ...(phase !== undefined && {
        phases: addWorkflowPhase(rest.phases, phase),
        reusedPhases: addWorkflowReusedPhase(rest.reusedPhases ?? [], phase),
      }),
      ...(entry.workspaceId !== undefined && {
        reusedWorkspaces: [
          ...(rest.reusedWorkspaces ?? []),
          { workspaceId: entry.workspaceId, label: entry.label ?? "reused agent" },
        ],
      }),
    },
  ];
};

export const withAgentChange = (
  run: WorkflowRunView,
  runId: string,
  change: Partial<WorkflowAgentView>,
): WorkflowRunView => ({
  ...run,
  agents: run.agents.map((agent) => (agent.runId === runId ? { ...agent, ...change } : agent)),
});

export const concludeWorkflow = (exit: Exit.Exit<WorkflowSandboxOutcome>): WorkflowConclusion => {
  if (Exit.isSuccess(exit)) {
    const outcome = exit.value;
    if (outcome._tag === "Completed")
      return { state: "completed", value: outcome.value, output: outcome.output };
    if (outcome.kind === "aborted") return { state: "stopped", output: outcome.output };
    return {
      state: "failed",
      failure: {
        ...outcome.failure,
        kind: outcome.kind,
        ...(outcome.kind !== "script" && { name: outcome.failure.name ?? "SandboxError" }),
      },
      output: outcome.output,
    };
  }
  if (Cause.hasInterruptsOnly(exit.cause)) return { state: "stopped", output: [] };
  const detail = Cause.pretty(exit.cause).trim();
  return {
    state: "failed",
    failure: {
      kind: "runner",
      name: "WorkflowRunnerError",
      message: (detail.split("\n")[0] ?? "") || "The workflow runner failed unexpectedly.",
      ...(detail.includes("\n") && { stack: detail }),
    },
    output: [],
  };
};

export const finishWorkflowRun = (
  run: WorkflowRunView,
  conclusion: WorkflowConclusion,
  result: WorkflowResult | undefined,
  at: number,
): WorkflowRunView => ({
  ...conclusion.output.reduce(
    (current, message) => withLogEntry(current, { at, level: "info", message }),
    run,
  ),
  state: conclusion.state,
  endedAt: at,
  ...(result && { result }),
  ...(conclusion.failure && { failure: conclusion.failure }),
});

export const retainWorkflowRuns = (
  runs: ReadonlyArray<WorkflowRunView>,
): ReadonlyArray<WorkflowRunView> => {
  const finished = runs.filter((run) => isWorkflowRunFinished(run.state));
  if (finished.length <= WORKFLOW_RETAINED_RUNS) return runs;
  const evicted = new Set(
    [...finished]
      .toSorted((left, right) => (left.endedAt ?? 0) - (right.endedAt ?? 0))
      .slice(0, finished.length - WORKFLOW_RETAINED_RUNS)
      .map((run) => run.id),
  );
  return runs.filter((run) => !evicted.has(run.id));
};
