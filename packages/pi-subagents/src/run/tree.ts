import type { RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID, type SubagentRunView, type SubagentTreeRootView } from "./model.ts";

const parentIdOf = (view: SubagentRunView): string => view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;

export const runDepth = (view: SubagentRunView): number => {
  const depth = view.depth;
  return depth !== undefined && Number.isSafeInteger(depth) && depth >= 1 ? depth : 1;
};

export const isRunInSubtree = (
  records: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
  candidateRunId: string,
): boolean => {
  let current = records.get(candidateRunId);
  const visited = new Set<string>();
  while (current) {
    if (current.view.id === rootRunId) return true;
    if (!visited.add(current.view.id)) return false;
    const parentRunId = parentIdOf(current.view);
    if (parentRunId === SUBAGENT_ROOT_RUN_ID) return false;
    current = records.get(parentRunId);
  }
  return false;
};

export const descendantRunIds = (
  records: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
): ReadonlyArray<string> =>
  [...records.values()]
    .filter((record) =>
      rootRunId === SUBAGENT_ROOT_RUN_ID
        ? true
        : record.view.id !== rootRunId && isRunInSubtree(records, rootRunId, record.view.id),
    )
    .sort((left, right) => runDepth(right.view) - runDepth(left.view))
    .map((record) => record.view.id);

export interface ProjectedRunTree {
  readonly root: SubagentTreeRootView;
  readonly runs: ReadonlyArray<SubagentRunView>;
}

export const projectRunTree = (records: ReadonlyMap<string, RunRecord>): ProjectedRunTree => {
  const directCounts = new Map<string, number>();
  const descendantCounts = new Map<string, number>();
  for (const record of records.values()) {
    const parentRunId = parentIdOf(record.view);
    directCounts.set(parentRunId, (directCounts.get(parentRunId) ?? 0) + 1);
    let currentParent = parentRunId;
    const visited = new Set<string>();
    while (currentParent !== SUBAGENT_ROOT_RUN_ID && visited.add(currentParent)) {
      descendantCounts.set(currentParent, (descendantCounts.get(currentParent) ?? 0) + 1);
      const parent = records.get(currentParent);
      if (!parent) break;
      currentParent = parentIdOf(parent.view);
    }
  }
  const root: SubagentTreeRootView = Object.freeze({
    id: SUBAGENT_ROOT_RUN_ID,
    depth: 0,
    directChildCount: directCounts.get(SUBAGENT_ROOT_RUN_ID) ?? 0,
    descendantCount: records.size,
  });
  return {
    root,
    runs: [...records.values()].map((record) => ({
      ...record.view,
      parentRunId: parentIdOf(record.view),
      depth: runDepth(record.view),
      directChildCount: directCounts.get(record.view.id) ?? 0,
      descendantCount: descendantCounts.get(record.view.id) ?? 0,
    })),
  };
};
