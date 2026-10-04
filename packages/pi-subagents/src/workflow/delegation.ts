import {
  SUBAGENT_ROOT_RUN_ID,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import type { WorkflowAgentSpend } from "./model.ts";

/** Each run's direct children in the projection, by parent run id. */
const childrenByParent = (
  projection: SubagentProjection,
): ReadonlyMap<string, ReadonlyArray<SubagentRunView>> => {
  const children = new Map<string, SubagentRunView[]>();
  for (const run of projection.runs) {
    const parent = run.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
    if (parent === SUBAGENT_ROOT_RUN_ID) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(run);
    else children.set(parent, [run]);
  }
  return children;
};

/** The subagents `runId` started itself, and theirs, at every depth. */
const descendantsOf = (
  children: ReadonlyMap<string, ReadonlyArray<SubagentRunView>>,
  runId: string,
): ReadonlyArray<SubagentRunView> => {
  const found: SubagentRunView[] = [];
  const visited = new Set([runId]);
  const pending = [...(children.get(runId) ?? [])];
  for (let run = pending.pop(); run !== undefined; run = pending.pop()) {
    if (visited.has(run.id)) continue;
    visited.add(run.id);
    found.push(run);
    pending.push(...(children.get(run.id) ?? []));
  }
  return found;
};

/**
 * What the subagents of running workflow agents use: the ones each agent started itself, and
 * theirs, at every depth. The projection drops an ended subagent's record once enough runs have
 * ended, so each one's latest spend is kept until its agent settles.
 */
export interface WorkflowDelegation {
  /** Notes what the subagents of each agent in `agentIds` have used so far. */
  readonly observe: (projection: SubagentProjection, agentIds: Iterable<string>) => void;
  /** Output tokens the agent's subagents had used when last observed. */
  readonly output: (agentId: string) => number;
  /** What each of the agent's subagents used, observed once more, and forgets them. */
  readonly settle: (
    projection: SubagentProjection,
    agentId: string,
  ) => ReadonlyArray<WorkflowAgentSpend>;
}

export const makeWorkflowDelegation = (): WorkflowDelegation => {
  const seen = new Map<string, Map<string, WorkflowAgentSpend>>();

  const observe: WorkflowDelegation["observe"] = (projection, agentIds) => {
    let children: ReadonlyMap<string, ReadonlyArray<SubagentRunView>> | undefined;
    for (const agentId of agentIds) {
      children ??= childrenByParent(projection);
      const descendants = descendantsOf(children, agentId);
      if (descendants.length === 0) continue;
      const spends = seen.get(agentId) ?? new Map<string, WorkflowAgentSpend>();
      // A record still shown is the subagent's latest; one dropped keeps its last spend.
      for (const run of descendants)
        spends.set(run.id, { usage: run.usage, toolUses: run.toolUses ?? 0 });
      seen.set(agentId, spends);
    }
  };

  const output: WorkflowDelegation["output"] = (agentId) => {
    let total = 0;
    for (const spend of seen.get(agentId)?.values() ?? []) total += spend.usage.output;
    return total;
  };

  const settle: WorkflowDelegation["settle"] = (projection, agentId) => {
    observe(projection, [agentId]);
    const spends = [...(seen.get(agentId)?.values() ?? [])];
    seen.delete(agentId);
    return spends;
  };

  return { observe, output, settle };
};
