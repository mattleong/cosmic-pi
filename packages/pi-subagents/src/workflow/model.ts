import type * as Schema from "effect/Schema";
import { ACTIVITY_LIMITS } from "pi-cosmic-ui/activity";
import { safeTextPrefix } from "pi-cosmic-core";
import { emptyUsage, type SubagentUsage } from "../run/model.ts";
import { addUsage } from "../run/state.ts";
import type { WorkflowPhase } from "./script.ts";

/** Claude-Code-compatible backstop on agent() calls in one run. */
export const WORKFLOW_AGENT_LIMIT = 1_000;
export const WORKFLOW_LOG_LIMIT = 200;
export const WORKFLOW_LOG_ENTRY_MAX_CHARS = 2_000;
/** Warnings kept apart from the log, so later output can't evict what explains null results. */
export const WORKFLOW_WARNING_LIMIT = 12;
/** Finished runs kept for status, resume and Activity history. */
export const WORKFLOW_RETAINED_RUNS = 32;
/** Verbatim args stay small enough to show and to journal. */
export const WORKFLOW_ARGS_MAX_CHARS = 64 * 1024;
/** Phase titles as Activity shows them; a nested workflow's prefix is clipped to fit. */
export const WORKFLOW_PHASE_TITLE_MAX_CHARS = ACTIVITY_LIMITS.phaseTitle;
/** agent() labels as Activity and notifications show them. */
export const WORKFLOW_AGENT_LABEL_MAX_CHARS = 80;
/** meta.phases plus phases added at runtime. */
export const WORKFLOW_RUN_PHASE_LIMIT = 64;
/** Planned agents one run shows: its script's and those of the workflows it nests. */
export const WORKFLOW_RUN_PLANNED_LIMIT = 256;
/** The narrator line: the newest log line, on one line. */
export const WORKFLOW_NARRATOR_MAX_CHARS = 200;
/** Result text carried by status and the notification, leaving room in its 32 KiB for the rest. */
export const WORKFLOW_RESULT_MAX_CHARS = 28 * 1024;
/**
 * What a run's notification content may use once redacted as the host redacts it; the host
 * clips at 32 KiB, and this bound keeps a margin below that.
 */
export const WORKFLOW_NOTIFICATION_MAX_CHARS = 30 * 1024;
const WORKFLOW_CONCURRENCY_LIMIT = 16;

/**
 * Agents one run executes at once by CPU count, as Claude Code caps them: at most 16, leaving two
 * cores for Pi and its tools, and always at least one. Every run has these slots of its own,
 * apart from the root's direct-child limit, which governs only the main agent's own subagents.
 */
export const workflowConcurrency = (availableParallelism: number): number =>
  Math.min(WORKFLOW_CONCURRENCY_LIMIT, Math.max(1, Math.floor(availableParallelism) - 2));

/** How a run ends by itself or when stopped, as opposed to a teardown interrupting it. */
export type WorkflowEndedState = "completed" | "failed" | "stopped";
export type WorkflowRunState = "running" | "stopping" | WorkflowEndedState;
/** Who asked a run to stop: the main agent's tool call or the user, for example in Activity. */
export type WorkflowStopOrigin = "tool" | "user";
export type WorkflowAgentState =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "skipped";

/** Whether a run's state, or its record's, is its end; `interrupted` is a teardown's. */
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

/**
 * Why a queued agent waits: for one of its run's slots, or behind a writer it conflicts with. A
 * writer the user paused never clears by itself.
 */
export type WorkflowAgentWaiting =
  | { readonly kind: "slot" }
  | {
      readonly kind: "writer";
      /** The writer's subagent run id, which a paused writer is inspected and resumed by. */
      readonly runId: string;
      readonly name: string;
      readonly paused: boolean;
    };

export const sameWorkflowWaiting = (
  left: WorkflowAgentWaiting | undefined,
  right: WorkflowAgentWaiting | undefined,
): boolean =>
  left?.kind === right?.kind &&
  (left?.kind !== "writer" ||
    (right?.kind === "writer" &&
      left.runId === right.runId &&
      left.name === right.name &&
      left.paused === right.paused));

export interface WorkflowAgentView {
  /** 1-based position among this run's live agent() calls. */
  readonly callId: number;
  /** Reserved subagent run id; stable from queued through finished. */
  readonly runId: string;
  readonly label: string;
  readonly phase?: string | undefined;
  readonly profile?: string | undefined;
  readonly state: WorkflowAgentState;
  readonly queuedAt: number;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  /** Isolated writer worktree whose proposal the main agent reviews. */
  readonly workspaceId?: string | undefined;
  /**
   * The writer's worktree held no changes once it settled, so it was discarded: no proposal
   * awaits review, and a resume reuses the writer's result like a reader's.
   */
  readonly unchanged?: true | undefined;
  /**
   * Why the agent ended without a result: its agent() call resolved null, or threw a budget error
   * when the budget refused it while queued.
   */
  readonly reason?: string | undefined;
  /** Why a queued agent waits, once a start had to; cleared when it starts or settles. */
  readonly waiting?: WorkflowAgentWaiting | undefined;
}

/** What one settled live agent used in its workflow run: its usage and the tool calls it started. */
export interface WorkflowAgentSpend {
  readonly usage: SubagentUsage;
  readonly toolUses: number;
}

/** What several agents used together, such as an agent and the subagents it started itself. */
export const sumWorkflowSpends = (spends: ReadonlyArray<WorkflowAgentSpend>): WorkflowAgentSpend =>
  spends.reduce(
    (total, spend) => ({
      usage: addUsage(total.usage, spend.usage),
      toolUses: Math.min(Number.MAX_SAFE_INTEGER, total.toolUses + spend.toolUses),
    }),
    { usage: emptyUsage(), toolUses: 0 },
  );

/** What a run's settled live agents used; results reused from a resumed run cost nothing here. */
export interface WorkflowUsage extends SubagentUsage {
  readonly toolUses: number;
  /** Agents that used tokens without a known cost, which makes a known cost a lower bound. */
  readonly unpriced: number;
}

export const emptyWorkflowUsage = (): WorkflowUsage => ({
  ...emptyUsage(),
  toolUses: 0,
  unpriced: 0,
});

/** Adds one settled agent's spend to its run's usage. */
export const addWorkflowUsage = (
  usage: WorkflowUsage,
  spend: WorkflowAgentSpend,
): WorkflowUsage => ({
  ...addUsage(usage, spend.usage),
  toolUses: Math.min(Number.MAX_SAFE_INTEGER, usage.toolUses + spend.toolUses),
  unpriced: usage.unpriced + Number(spend.usage.cost === undefined && spend.usage.totalTokens > 0),
});

/** A run's token budget: a hard ceiling on the output tokens its live agents produce. */
export interface WorkflowBudgetView {
  readonly total: number;
  /**
   * Output tokens counted so far: settled agents' and running agents' live usage, the subagents
   * they start themselves included, refreshed when an agent settles, when live usage grows by a
   * twentieth of the total, and when the ceiling is reached. Reused results cost nothing here.
   */
  readonly spent: number;
  /** agent() calls the exhausted budget refused, each failing with a budget error. */
  readonly refused: number;
}

/** Why the call that claims a planned agent the user skipped resolves null. */
export const WORKFLOW_SKIPPED_BEFORE_START = "skipped by the user before it started";

/**
 * An agent a phase of the script's meta declares. It never starts anything: the first matching
 * agent() call claims it and takes over its run id, so its Activity row keeps one id from planned
 * through queued, running and finished.
 */
export interface WorkflowPlannedAgent {
  /** A subagent run id reserved when the run started. */
  readonly runId: string;
  readonly phase: string;
  readonly label: string;
  readonly profile?: string | undefined;
  /**
   * The nested workflow() whose meta declares it, by name; absent for the run's own script. Only
   * calls made in that workflow claim it outside a phase.
   */
  readonly workflow?: string | undefined;
  /**
   * When the user skipped it, before any call claimed it. The call that claims it resolves null at
   * once without starting anything; one no call claims stays skipped instead of never run.
   */
  readonly skippedAt?: number | undefined;
}

/** Whether the user skipped a planned agent before any call claimed it. */
export const isWorkflowPlannedSkipped = (agent: WorkflowPlannedAgent): boolean =>
  agent.skippedAt !== undefined;

/** A worktree an earlier run's writer left for review, carried by the run that reused it. */
export interface WorkflowReusedWorkspace {
  readonly workspaceId: string;
  readonly label: string;
}

/** Results reused from the resumed run in one display phase, which count as its finished work. */
export interface WorkflowReusedPhase {
  readonly title: string;
  readonly count: number;
}

/** A worktree proposal the main agent reviews with subagent_workspace. */
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
  readonly name?: string | undefined;
  readonly message: string;
  readonly stack?: string | undefined;
}

/** The script's return value as text, bounded for status and notifications. */
export interface WorkflowResult {
  readonly text: string;
  readonly clipped: boolean;
  /** Temporary file holding the full value when the text was clipped. */
  readonly path?: string | undefined;
}

export interface WorkflowRunView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: WorkflowSource;
  readonly sha256: string;
  /** meta.phases followed by phases first seen at runtime, in order. */
  readonly phases: ReadonlyArray<WorkflowPhase>;
  readonly currentPhase?: string | undefined;
  readonly state: WorkflowRunState;
  readonly startedAt: number;
  readonly endedAt?: number | undefined;
  /** Live agent() calls; results reused from a resumed run are only counted. */
  readonly agents: ReadonlyArray<WorkflowAgentView>;
  /**
   * Declared agents no call has claimed yet, in declaration order, including those the user
   * skipped. A finished run keeps the entries no call claimed.
   */
  readonly planned: ReadonlyArray<WorkflowPlannedAgent>;
  readonly reused: number;
  /** Reused results per display phase; read them with {@link workflowReusedByPhase}. */
  readonly reusedPhases?: ReadonlyArray<WorkflowReusedPhase> | undefined;
  /** Worktrees of reused writer calls, which still await review. */
  readonly reusedWorkspaces?: ReadonlyArray<WorkflowReusedWorkspace> | undefined;
  /** Who asked the run to stop; unset when nobody did or the main agent's stop call ended early. */
  readonly stoppedBy?: WorkflowStopOrigin | undefined;
  readonly logs: ReadonlyArray<WorkflowLogEntry>;
  /** The newest non-blank log line on one line, at most {@link WORKFLOW_NARRATOR_MAX_CHARS}. */
  readonly lastLog?: string | undefined;
  /** The newest {@link WORKFLOW_WARNING_LIMIT} warnings, which outlive the log's eviction. */
  readonly warnings?: ReadonlyArray<WorkflowLogEntry> | undefined;
  /** Every warning the run logged, including those no longer kept. */
  readonly warningCount?: number | undefined;
  /** What its settled live agents used; reused results are only counted in `reused`. */
  readonly usage: WorkflowUsage;
  /** The token budget its start passed, if any. */
  readonly budget?: WorkflowBudgetView | undefined;
  /**
   * The run's private copy of its script. The main agent edits and starts it again only for an
   * inline script; a saved workflow or script file is fixed in its own file.
   */
  readonly scriptPath?: string | undefined;
  /** One JSON line per finished agent() call; set once the first line is written. */
  readonly journalPath?: string | undefined;
  readonly resumedFrom?: string | undefined;
  readonly args: Schema.Json;
  readonly result?: WorkflowResult | undefined;
  readonly failure?: WorkflowFailure | undefined;
}

/** Agents in each state; stopped and skipped agents are counted apart. */
export interface WorkflowAgentCounts {
  readonly queued: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly stopped: number;
  readonly skipped: number;
}

export const countWorkflowAgents = (
  agents: ReadonlyArray<WorkflowAgentView>,
): WorkflowAgentCounts => {
  const counts = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    stopped: 0,
    skipped: 0,
  } satisfies Record<WorkflowAgentState, number>;
  for (const agent of agents) counts[agent.state] += 1;
  return counts;
};

/** Planned agents the user skipped that no call has claimed. */
export const workflowSkippedPlanned = (run: Pick<WorkflowRunView, "planned">): number =>
  run.planned.filter(isWorkflowPlannedSkipped).length;

/**
 * A run's agents in each state, where planned agents the user skipped before any call claimed
 * them count as skipped.
 */
export const countWorkflowRunAgents = (run: WorkflowRunView): WorkflowAgentCounts => {
  const counts = countWorkflowAgents(run.agents);
  return { ...counts, skipped: counts.skipped + workflowSkippedPlanned(run) };
};

/**
 * Every agent a run counts: its live calls, its reused results and the planned agents the user
 * skipped before any call claimed them.
 */
export const workflowAgentTotal = (run: WorkflowRunView): number =>
  run.agents.length + run.reused + workflowSkippedPlanned(run);

/**
 * Worktrees this run's writers left for review: reused ones first, then live ones in call order.
 * A writer whose worktree held no changes was discarded and is only counted.
 */
export const workflowWorkspaces = (run: WorkflowRunView): ReadonlyArray<WorkflowWorkspace> => [
  ...(run.reusedWorkspaces ?? []).map((workspace) => ({ ...workspace, state: "reused" as const })),
  ...run.agents.flatMap((agent) =>
    agent.workspaceId === undefined || agent.unchanged
      ? []
      : [{ workspaceId: agent.workspaceId, label: agent.label, state: agent.state }],
  ),
];

/** Worktree writers whose worktrees held no changes and were discarded. */
export const workflowUnchangedWorkspaces = (run: WorkflowRunView): number =>
  run.agents.filter((agent) => agent.unchanged).length;

/**
 * Reused results per raw phase title, as `run.phases` and agent views spell it. A phase whose
 * calls were all reused has finished work even though it has no agent views.
 */
export const workflowReusedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  new Map((run.reusedPhases ?? []).map((phase) => [phase.title, phase.count]));

/** Counts one more reused result in `title`. */
export const addWorkflowReusedPhase = (
  phases: ReadonlyArray<WorkflowReusedPhase>,
  title: string,
): ReadonlyArray<WorkflowReusedPhase> =>
  phases.some((phase) => phase.title === title)
    ? phases.map((phase) => (phase.title === title ? { title, count: phase.count + 1 } : phase))
    : [...phases, { title, count: 1 }];

const appendBounded = (
  entries: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
  limit: number,
): ReadonlyArray<WorkflowLogEntry> => {
  const message =
    entry.message.length > WORKFLOW_LOG_ENTRY_MAX_CHARS
      ? `${entry.message.slice(0, WORKFLOW_LOG_ENTRY_MAX_CHARS - 1)}…`
      : entry.message;
  const next = [...entries, { ...entry, message }];
  return next.length > limit ? next.slice(next.length - limit) : next;
};

/** Appends a log line, keeping the newest {@link WORKFLOW_LOG_LIMIT} entries. */
export const appendWorkflowLog = (
  logs: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
): ReadonlyArray<WorkflowLogEntry> => appendBounded(logs, entry, WORKFLOW_LOG_LIMIT);

/** Appends a warning, keeping the newest {@link WORKFLOW_WARNING_LIMIT}. */
export const appendWorkflowWarning = (
  warnings: ReadonlyArray<WorkflowLogEntry>,
  entry: WorkflowLogEntry,
): ReadonlyArray<WorkflowLogEntry> => appendBounded(warnings, entry, WORKFLOW_WARNING_LIMIT);

/** Trimmed display text of at most `maximum` characters, ending in an ellipsis when clipped. */
const displayText = (text: string, maximum: number): string => {
  const trimmed = text.trim();
  return trimmed.length > maximum ? `${safeTextPrefix(trimmed, maximum - 1)}…` : trimmed;
};

/** A log message as the narrator line shows it; undefined when it is blank. */
export const workflowNarratorLine = (message: string): string | undefined =>
  displayText(message.replace(/\s+/gu, " "), WORKFLOW_NARRATOR_MAX_CHARS) || undefined;

const countByPhase = (agents: ReadonlyArray<WorkflowPlannedAgent>): ReadonlyMap<string, number> =>
  agents.reduce(
    (counts, agent) => counts.set(agent.phase, (counts.get(agent.phase) ?? 0) + 1),
    new Map<string, number>(),
  );

/** Planned agents a call can still claim and run, per raw phase title; skipped ones aren't. */
export const workflowPlannedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  countByPhase(run.planned.filter((agent) => !isWorkflowPlannedSkipped(agent)));

/** Planned agents the user skipped before any call claimed them, per raw phase title. */
export const workflowSkippedByPhase = (run: WorkflowRunView): ReadonlyMap<string, number> =>
  countByPhase(run.planned.filter(isWorkflowPlannedSkipped));

/** A phase title bounded for display; nested prefixes can push a valid title past the limit. */
export const workflowPhaseTitle = (title: string): string =>
  displayText(title, WORKFLOW_PHASE_TITLE_MAX_CHARS);

/** An agent() label bounded for display; empty labels are treated as absent. */
export const workflowAgentLabel = (label: string): string | undefined =>
  displayText(label, WORKFLOW_AGENT_LABEL_MAX_CHARS) || undefined;

/** Adds a phase the first time it is seen; titles are unique and the list is bounded. */
export const addWorkflowPhase = (
  phases: ReadonlyArray<WorkflowPhase>,
  title: string,
  detail?: string,
): ReadonlyArray<WorkflowPhase> =>
  phases.some((phase) => phase.title === title) || phases.length >= WORKFLOW_RUN_PHASE_LIMIT
    ? phases
    : [...phases, { title, ...(detail !== undefined && { detail }) }];
