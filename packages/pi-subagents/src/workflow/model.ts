import * as Schema from "effect/Schema";
import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { safeTextPrefix } from "pi-cosmic-core";
import { emptyUsage, type SubagentUsage } from "../run/model.ts";
import { addUsage } from "../run/state.ts";
import type { WorkflowPhase, WorkflowPlannedAgentSpec } from "./script.ts";

export const NonEmptyText = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const WORKFLOW_AGENT_LIMIT = 1_000;
export const WORKFLOW_LOG_LIMIT = 200;
const WORKFLOW_LOG_ENTRY_MAX_CHARS = 2_000;
const WORKFLOW_WARNING_LIMIT = 12;
export const WORKFLOW_RETAINED_RUNS = 32;
export const WORKFLOW_ARGS_MAX_CHARS = 64 * 1024;
export const WORKFLOW_PHASE_TITLE_MAX_CHARS = ACTIVITY_LIMITS.phaseTitle;
export const WORKFLOW_AGENT_LABEL_MAX_CHARS = 80;
const WORKFLOW_RUN_PHASE_LIMIT = 64;
export const WORKFLOW_RUN_PLANNED_LIMIT = 256;
export const WORKFLOW_NARRATOR_MAX_CHARS = 200;
export const WORKFLOW_RESULT_MAX_CHARS = 28 * 1024;
export const WORKFLOW_NOTIFICATION_MAX_CHARS = 30 * 1024;
const WORKFLOW_CONCURRENCY_LIMIT = 16;

export const workflowConcurrency = (availableParallelism: number): number =>
  Math.min(WORKFLOW_CONCURRENCY_LIMIT, Math.max(1, Math.floor(availableParallelism) - 2));

export type WorkflowEndedState = "completed" | "failed" | "stopped";
export type WorkflowRunState = "running" | "stopping" | WorkflowEndedState;
export type WorkflowStopOrigin = "tool" | "user";
export type WorkflowAgentState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "skipped";

export const isWorkflowRunFinished = (
  state: WorkflowRunState | "interrupted",
): state is WorkflowEndedState =>
  state === "completed" || state === "failed" || state === "stopped";

export const isWorkflowAgentFinished = (state: WorkflowAgentState): boolean =>
  state !== "queued" && state !== "running";

export type WorkflowSource =
  | { readonly kind: "inline" }
  | {
      readonly kind: "saved";
      readonly name: string;
      readonly scope: "project" | "user";
      readonly path: string;
    }
  | { readonly kind: "file"; readonly path: string };

export type WorkflowAgentWaiting =
  | { readonly kind: "slot" }
  | {
      readonly kind: "writer";
      readonly runId: string;
      readonly name: string;
      readonly paused: boolean;
    };

export interface WorkflowAgentView {
  readonly callId: number;
  readonly runId: string;
  readonly label: string;
  readonly phase?: string | undefined;
  readonly profile?: string | undefined;
  readonly state: WorkflowAgentState;
  readonly queuedAt: number;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly workspaceId?: string | undefined;
  readonly unchanged?: true | undefined;
  readonly reason?: string | undefined;
  readonly waiting?: WorkflowAgentWaiting | undefined;
}

export interface WorkflowAgentSpend {
  readonly usage: SubagentUsage;
  readonly toolUses: number;
}

export const sumWorkflowSpends = (spends: ReadonlyArray<WorkflowAgentSpend>): WorkflowAgentSpend =>
  spends.reduce(
    (total, spend) => ({
      usage: addUsage(total.usage, spend.usage),
      toolUses: Math.min(Number.MAX_SAFE_INTEGER, total.toolUses + spend.toolUses),
    }),
    { usage: emptyUsage(), toolUses: 0 },
  );

export interface WorkflowUsage extends SubagentUsage {
  readonly toolUses: number;
  readonly unpriced: number;
}

export const emptyWorkflowUsage = (): WorkflowUsage => ({
  ...emptyUsage(),
  toolUses: 0,
  unpriced: 0,
});

export const addWorkflowUsage = (
  usage: WorkflowUsage,
  spend: WorkflowAgentSpend,
): WorkflowUsage => ({
  ...addUsage(usage, spend.usage),
  toolUses: Math.min(Number.MAX_SAFE_INTEGER, usage.toolUses + spend.toolUses),
  unpriced: usage.unpriced + Number(spend.usage.cost === undefined && spend.usage.totalTokens > 0),
});

export interface WorkflowBudgetView {
  readonly total: number;
  readonly spent: number;
  readonly refused: number;
}

export const WORKFLOW_SKIPPED_BEFORE_START = "skipped by the user before it started";

export interface WorkflowPlannedAgent extends WorkflowPlannedAgentSpec {
  readonly runId: string;
  readonly skippedAt?: number | undefined;
}

export const isWorkflowPlannedSkipped = (agent: WorkflowPlannedAgent): boolean =>
  agent.skippedAt !== undefined;

interface WorkflowReusedWorkspace {
  readonly workspaceId: string;
  readonly label: string;
}

export interface WorkflowReusedPhase {
  readonly title: string;
  readonly count: number;
}

export interface WorkflowWorkspace {
  readonly workspaceId: string;
  readonly label: string;
  readonly state: WorkflowAgentState | "reused";
}

export interface WorkflowLogEntry {
  readonly at: number;
  readonly level: "info" | "warning";
  readonly message: string;
}

export interface WorkflowFailure {
  readonly kind?: "script" | "timeout" | "sandbox" | "runner" | undefined;
  readonly name?: string | undefined;
  readonly message: string;
  readonly stack?: string | undefined;
}

export interface WorkflowResult {
  readonly text: string;
  readonly clipped: boolean;
  readonly path?: string | undefined;
}

export interface WorkflowRunView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: WorkflowSource;
  readonly phases: ReadonlyArray<WorkflowPhase>;
  readonly currentPhase?: string | undefined;
  readonly state: WorkflowRunState;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  readonly agents: ReadonlyArray<WorkflowAgentView>;
  readonly planned: ReadonlyArray<WorkflowPlannedAgent>;
  readonly reused: number;
  readonly reusedPhases?: ReadonlyArray<WorkflowReusedPhase> | undefined;
  readonly reusedWorkspaces?: ReadonlyArray<WorkflowReusedWorkspace> | undefined;
  readonly stoppedBy?: WorkflowStopOrigin | undefined;
  readonly logs: ReadonlyArray<WorkflowLogEntry>;
  readonly lastLog?: string | undefined;
  readonly warnings?: ReadonlyArray<WorkflowLogEntry> | undefined;
  readonly warningCount?: number | undefined;
  readonly usage: WorkflowUsage;
  readonly budget?: WorkflowBudgetView | undefined;
  readonly scriptPath?: string | undefined;
  readonly journalPath?: string | undefined;
  readonly resumedFrom?: string | undefined;
  readonly args: Schema.Json;
  readonly result?: WorkflowResult | undefined;
  readonly failure?: WorkflowFailure | undefined;
}

export type WorkflowAgentCounts = { readonly [State in WorkflowAgentState]: number };

export const countWorkflowAgents = (
  agents: ReadonlyArray<WorkflowAgentView>,
): WorkflowAgentCounts => {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, stopped: 0, skipped: 0 };
  for (const agent of agents) counts[agent.state] += 1;
  return counts;
};

export const workflowSkippedPlanned = (run: Pick<WorkflowRunView, "planned">): number =>
  run.planned.filter(isWorkflowPlannedSkipped).length;

export const countWorkflowRunAgents = (run: WorkflowRunView): WorkflowAgentCounts => {
  const counts = countWorkflowAgents(run.agents);
  return { ...counts, skipped: counts.skipped + workflowSkippedPlanned(run) };
};

export const workflowAgentTotal = (run: WorkflowRunView): number =>
  run.agents.length + run.reused + workflowSkippedPlanned(run);

export const workflowWorkspaces = (run: WorkflowRunView): ReadonlyArray<WorkflowWorkspace> => [
  ...(run.reusedWorkspaces ?? []).map((workspace) => ({ ...workspace, state: "reused" as const })),
  ...run.agents.flatMap((agent) =>
    agent.workspaceId === undefined || agent.unchanged
      ? []
      : [{ workspaceId: agent.workspaceId, label: agent.label, state: agent.state }],
  ),
];

export const workflowUnchangedWorkspaces = (run: WorkflowRunView): number =>
  run.agents.filter((agent) => agent.unchanged).length;

export const workflowReusedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  new Map((run.reusedPhases ?? []).map((phase) => [phase.title, phase.count]));

export const addWorkflowReusedPhase = (
  phases: ReadonlyArray<WorkflowReusedPhase>,
  title: string,
): ReadonlyArray<WorkflowReusedPhase> =>
  phases.some((phase) => phase.title === title)
    ? phases.map((phase) => (phase.title === title ? { title, count: phase.count + 1 } : phase))
    : [...phases, { title, count: 1 }];

const clipped = (text: string, maximum: number): string =>
  text.length > maximum ? `${safeTextPrefix(text, maximum - 1)}…` : text;

const appendBounded = (
  entries: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
  limit: number,
): ReadonlyArray<WorkflowLogEntry> => {
  const next = [
    ...entries,
    { ...entry, message: clipped(entry.message, WORKFLOW_LOG_ENTRY_MAX_CHARS) },
  ];
  return next.length > limit ? next.slice(next.length - limit) : next;
};

export const appendWorkflowLog = (
  logs: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
): ReadonlyArray<WorkflowLogEntry> => appendBounded(logs, entry, WORKFLOW_LOG_LIMIT);

export const appendWorkflowWarning = (
  warnings: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
): ReadonlyArray<WorkflowLogEntry> => appendBounded(warnings, entry, WORKFLOW_WARNING_LIMIT);

const displayText = (text: string, maximum: number): string => clipped(text.trim(), maximum);

export const workflowNarratorLine = (message: string): string | undefined =>
  displayText(message.replace(/\s+/gu, " "), WORKFLOW_NARRATOR_MAX_CHARS) || undefined;

const countByPhase = (agents: ReadonlyArray<WorkflowPlannedAgent>): ReadonlyMap<string, number> =>
  agents.reduce(
    (counts, agent) => counts.set(agent.phase, (counts.get(agent.phase) ?? 0) + 1),
    new Map<string, number>(),
  );

export const workflowPlannedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  countByPhase(run.planned.filter((agent) => !isWorkflowPlannedSkipped(agent)));

export const workflowSkippedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  countByPhase(run.planned.filter(isWorkflowPlannedSkipped));

export const workflowPhaseTitle = (title: string): string =>
  displayText(title, WORKFLOW_PHASE_TITLE_MAX_CHARS);

export const workflowAgentLabel = (label: string): string | undefined =>
  displayText(label, WORKFLOW_AGENT_LABEL_MAX_CHARS) || undefined;

export const addWorkflowPhase = (
  phases: ReadonlyArray<WorkflowPhase>,
  title: string,
  detail?: string,
): ReadonlyArray<WorkflowPhase> =>
  phases.some((phase) => phase.title === title) || phases.length >= WORKFLOW_RUN_PHASE_LIMIT
    ? phases
    : [...phases, { title, ...(detail !== undefined && { detail }) }];
