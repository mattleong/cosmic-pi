import * as Effect from "effect/Effect";
import { runAttention, type RunAttention } from "../run/attention.ts";
import type { SubagentRunView } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowRunView } from "./model.ts";

/**
 * A running workflow agent whose subagent needs a person, by the one attention precedence
 * subagent_status uses: claim containment, writer admission paused by another run's containment,
 * a pause, or a question for subagent_reply.
 */
export type WorkflowAgentAttention = RunAttention & {
  readonly runId: string;
  /** Whether its subagent is a writer, which a paused agent's line names. */
  readonly writer: boolean;
};

/** Status of a run this activation holds, with its agents that need a person. */
export interface WorkflowViewStatus {
  readonly kind: "view";
  readonly run: WorkflowRunView;
  readonly attention: ReadonlyArray<WorkflowAgentAttention>;
}

/** The run's running agents whose subagents need a person, in call order. */
export const workflowAttention = (
  run: WorkflowRunView,
  subagents: ReadonlyArray<SubagentRunView>,
): ReadonlyArray<WorkflowAgentAttention> => {
  const views = new Map(subagents.map((view) => [view.id, view]));
  return run.agents.flatMap((agent) => {
    const view = agent.state === "running" ? views.get(agent.runId) : undefined;
    const attention = view && runAttention(view);
    return attention
      ? { ...attention, runId: agent.runId, writer: view.writeIntent === "writer" }
      : [];
  });
};

/** A held run's status, reading the subagent projection for its agents that need a person. */
export const workflowViewStatus = (
  subagents: Pick<SubagentServiceContract, "projection">,
  run: WorkflowRunView,
): Effect.Effect<WorkflowViewStatus> =>
  subagents.projection.pipe(
    Effect.map(
      (projection): WorkflowViewStatus => ({
        kind: "view",
        run,
        attention: workflowAttention(run, projection.runs),
      }),
    ),
  );
