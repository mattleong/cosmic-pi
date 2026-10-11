import * as Effect from "effect/Effect";
import { runAttention, type RunAttention } from "../run/attention.ts";
import type { SubagentRunView } from "../run/model.ts";
import type { SubagentServiceContract } from "../run/service.ts";
import type { WorkflowRunView } from "./model.ts";

export type WorkflowAgentAttention = RunAttention & {
  readonly runId: string;
  readonly writer: boolean;
};

export interface WorkflowViewStatus {
  readonly kind: "view";
  readonly run: WorkflowRunView;
  readonly attention: ReadonlyArray<WorkflowAgentAttention>;
}

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
