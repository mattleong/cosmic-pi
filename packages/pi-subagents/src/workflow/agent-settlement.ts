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

export interface WorkflowSettlement {
  readonly state: "completed" | "failed" | "stopped" | "skipped";
  readonly result: Schema.Json;
  readonly spend?: WorkflowAgentSpend | undefined;
  readonly startedAt?: number | undefined;
  readonly reason?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly unchanged?: true | undefined;
  readonly refusal?: string | undefined;
}

export interface WorkflowAccounted {
  readonly spend: WorkflowAgentSpend;
  readonly spent: number;
  readonly durationMs?: number | undefined;
  readonly workspaceId?: string | undefined;
}

const decodeResult = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const workflowReply = (result: Schema.Json, outputTokens: number): Schema.Json => ({
  result,
  outputTokens,
});

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

export const couldntStart = (error: { readonly message: string }): WorkflowSettlement =>
  nullSettlement("failed", `couldn't start: ${error.message}`);

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
  return Option.match(decodeResult(outcome.text), {
    onNone: () => nullSettlement("failed", "The structured result wasn't valid JSON.", spend),
    onSome: (result): WorkflowSettlement => ({ state: "completed", result, spend }),
  });
};

const keptWorktreeWarning = (label: string, workspaceId: string, error: SubagentError) =>
  subagentErrorCode(error) === "workspace_discard_incomplete"
    ? `agent "${label}"'s worktree ${workspaceId} made no changes but couldn't be fully discarded (${error.message}); discard it with subagent_workspace rather than reviewing it.`
    : `agent "${label}"'s worktree ${workspaceId} is kept for review: checking it for changes failed: ${error.message}`;

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

export interface WorkflowObservedRun {
  readonly spend: WorkflowAgentSpend;
  readonly startedAt?: number | undefined;
  readonly workspaceId?: string | undefined;
}

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

export const settlementWarning = (label: string, settlement: WorkflowSettlement): string => {
  const { state, reason } = settlement;
  const ended = state === "skipped" || state === "stopped" ? `was ${state}` : "failed";
  return `agent "${label}" ${ended}${reason ? `: ${reason}` : ""}`;
};

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
