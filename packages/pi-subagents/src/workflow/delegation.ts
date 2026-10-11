import {
  SUBAGENT_ROOT_RUN_ID,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import type { WorkflowAgentSpend } from "./model.ts";

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

export const makeWorkflowDelegation = () => {
  const seen = new Map<string, Map<string, WorkflowAgentSpend>>();

  const observe = (projection: SubagentProjection, agentIds: Iterable<string>): void => {
    let children: ReadonlyMap<string, ReadonlyArray<SubagentRunView>> | undefined;
    for (const agentId of agentIds) {
      children ??= childrenByParent(projection);
      const descendants = descendantsOf(children, agentId);
      if (descendants.length === 0) continue;
      const spends = seen.get(agentId) ?? new Map<string, WorkflowAgentSpend>();
      for (const run of descendants)
        spends.set(run.id, { usage: run.usage, toolUses: run.toolUses ?? 0 });
      seen.set(agentId, spends);
    }
  };

  const output = (agentId: string): number => {
    let total = 0;
    for (const spend of seen.get(agentId)?.values() ?? []) total += spend.usage.output;
    return total;
  };

  const settle = (
    projection: SubagentProjection,
    agentId: string,
  ): ReadonlyArray<WorkflowAgentSpend> => {
    observe(projection, [agentId]);
    const spends = [...(seen.get(agentId)?.values() ?? [])];
    seen.delete(agentId);
    return spends;
  };

  return { observe, output, settle };
};
