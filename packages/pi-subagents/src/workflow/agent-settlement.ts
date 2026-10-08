import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ResultContract } from "../domain/result-contract.ts";
import { subagentErrorCode, type SubagentError } from "../run/errors.ts";
import { emptyUsage, type SubagentProjection } from "../run/model.ts";
import type { OwnedRunOutcome } from "../run/owned-runs.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowAgentRun } from "./agent.ts";
import { WORKFLOW_BUDGET_REASON } from "./budget.ts";
import type { WorkflowAgentSpend, WorkflowAgentView } from "./model.ts";
import type { WorkflowResultLine } from "./results.ts";

/** How one live agent() call ended, before its view, usage and journals record it. */
export interface WorkflowSettlement {
  readonly state: "completed" | "failed" | "stopped" | "skipped";
  readonly result: Schema.Json;
  /** What the agent used, from its outcome; a call without one counts what its subagent shows. */
  readonly spend?: WorkflowAgentSpend | undefined;
  /** When the agent started running, once admitted. */
  readonly startedAt?: number | undefined;
  readonly reason?: string | undefined;
  /** The writer's worktree, once admitted. */
  readonly workspaceId?: string | undefined;
  /** The writer's worktree held no changes, so it was discarded instead of left for review. */
  readonly unchanged?: true | undefined;
  /**
   * Refused because the budget was exhausted: the message of the error the call throws in the
   * script. The run logs one warning for all of them.
   */
  readonly refusal?: string | undefined;
}

/**
 * What a settled call counted: its spend, the subagents its agent started itself included, the
 * output tokens its budget counted, and how long it ran.
 */
export interface WorkflowAccounted {
  readonly spend: WorkflowAgentSpend;
  readonly spent: number;
  readonly durationMs?: number | undefined;
  /**
   * The writer's worktree as its subagent shows it, for a call that ended without an outcome,
   * such as one skipped or stopped while it ran, whose settlement doesn't name it.
   */
  readonly workspaceId?: string | undefined;
}

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** The sandbox's reply: the result and the output tokens the call spent in this run. */
export const workflowReply = (result: Schema.Json, outputTokens: number): Schema.Json => ({
  result,
  outputTokens,
});

/**
 * The sandbox's reply to a call the budget refused: the prelude throws `refusal` as a budget
 * error once it has counted the output tokens the call spent, which are 0 unless a start the
 * budget gave up had already admitted the agent.
 */
export const workflowRefusalReply = (refusal: string, outputTokens: number): Schema.Json => ({
  result: null,
  outputTokens,
  refusal,
});

export const nullSettlement = (
  state: WorkflowSettlement["state"],
  reason: string,
  spend?: WorkflowAgentSpend,
): WorkflowSettlement => ({ state, result: null, reason, ...(spend !== undefined && { spend }) });

/** A call whose start the root won't admit, or whose launch didn't resolve. */
export const couldntStart = (error: { readonly message: string }): WorkflowSettlement =>
  nullSettlement("failed", `couldn't start: ${error.message}`);

/** A queued call the budget refused, with the message of the error it throws. */
export const overBudgetSettlement = (refusal: string): WorkflowSettlement => ({
  ...nullSettlement("skipped", WORKFLOW_BUDGET_REASON),
  refusal,
});

export const outcomeSettlement = (
  outcome: OwnedRunOutcome,
  contract: ResultContract | undefined,
): WorkflowSettlement => {
  const spend: WorkflowAgentSpend = { usage: outcome.usage, toolUses: outcome.toolUses };
  if (outcome.kind !== "completed") return nullSettlement(outcome.kind, outcome.reason, spend);
  if (!contract) return { state: "completed", result: outcome.text, spend };
  // A contract run completes only with the canonical JSON of its validated value.
  return Option.match(decodeResult(outcome.text), {
    onNone: () => nullSettlement("failed", "The structured result wasn't valid JSON.", spend),
    onSome: (result): WorkflowSettlement => ({ state: "completed", result, spend }),
  });
};

/** The warning for a worktree whose check or discard failed, so its proposal is kept. */
const keptWorktreeWarning = (label: string, workspaceId: string, error: SubagentError) =>
  subagentErrorCode(error) === "workspace_discard_incomplete"
    ? `agent "${label}"'s worktree ${workspaceId} made no changes but couldn't be fully discarded (${error.message}); discard it with subagent_workspace rather than reviewing it.`
    : `agent "${label}"'s worktree ${workspaceId} is kept for review: checking it for changes failed: ${error.message}`;

/**
 * A settled worktree writer's settlement once its worktree is checked. A worktree holding no
 * changes, not even an untracked or ignored file, is discarded and the settlement marked
 * `unchanged`, so the main agent has no empty proposal to review; the subagent service waits for
 * the writer's process cleanup, then checks and discards under the workspace lock. Work is never
 * deleted: a worktree holding anything, or that another run still works in, keeps its proposal,
 * and so does one whose check or discard fails, with one warning. Once the run is asked to stop,
 * a check that hasn't started is skipped and the proposal kept.
 */
export const discardUnchangedWorktree = (
  subagents: Pick<SubagentServiceContract, "workspaceDiscardUnchanged">,
  run: Pick<WorkflowAgentRun, "log" | "stopRequested">,
  label: string,
  settlement: WorkflowSettlement,
): Effect.Effect<WorkflowSettlement> => {
  const workspaceId = settlement.workspaceId;
  if (workspaceId === undefined) return Effect.succeed(settlement);
  return subagents.workspaceDiscardUnchanged(workspaceId, run.stopRequested).pipe(
    Effect.map(
      (discarded): WorkflowSettlement =>
        discarded ? { ...settlement, unchanged: true } : settlement,
    ),
    Effect.catch((error) =>
      run
        .log("warning", keptWorktreeWarning(label, workspaceId, error))
        .pipe(Effect.as(settlement)),
    ),
  );
};

/** What an agent used, and when it started and the worktree it wrote in when those are known. */
export interface WorkflowObservedRun {
  readonly spend: WorkflowAgentSpend;
  readonly startedAt?: number | undefined;
  readonly workspaceId?: string | undefined;
}

/**
 * What an agent without an outcome used, such as one skipped or stopped while it ran, when it
 * started and its worktree, from its subagent's view; nothing for one never admitted.
 */
export const observedRun = (projection: SubagentProjection, runId: string): WorkflowObservedRun => {
  const view = projection.runs.find((run) => run.id === runId);
  return view
    ? {
        spend: { usage: view.usage, toolUses: view.toolUses ?? 0 },
        startedAt: view.startedAt,
        workspaceId: view.workspaceId,
      }
    : { spend: { usage: emptyUsage(), toolUses: 0 } };
};

/** The warning a live call that resolved null logs. */
export const settlementWarning = (label: string, settlement: WorkflowSettlement): string => {
  const { state, reason } = settlement;
  const ended = state === "skipped" || state === "stopped" ? `was ${state}` : "failed";
  return `agent "${label}" ${ended}${reason ? `: ${reason}` : ""}`;
};

/**
 * A live call's results journal line, with the profile it ran with, which its view carries,
 * rather than a planned one. A completed call's line carries its resume key, so a later Pi
 * process can replay it. A writer's line names its worktree even when it was skipped or stopped
 * while it ran, so a later Pi process can still list that worktree for recovery.
 */
export const settledResultLine = (
  agent: WorkflowAgentView,
  key: string,
  settlement: WorkflowSettlement,
  accounted: WorkflowAccounted,
): WorkflowResultLine => ({
  callId: agent.callId,
  label: agent.label,
  phase: agent.phase,
  profile: agent.profile,
  state: settlement.state,
  reason: settlement.reason,
  runId: agent.runId,
  workspaceId: settlement.workspaceId ?? accounted.workspaceId,
  unchanged: settlement.unchanged,
  ...(settlement.state === "completed" && { key }),
  outputTokens: accounted.spent,
  usage: accounted.spend.usage,
  toolUses: accounted.spend.toolUses,
  durationMs: accounted.durationMs,
  result: settlement.result,
});
