import type { RunRecord } from "./internal.ts";
import { SUBAGENT_ROOT_RUN_ID, type SubagentRunView } from "./model.ts";
import { snapshotView } from "./state.ts";

const parentIdOf = (view: SubagentRunView): string => view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;

const runDepth = (view: SubagentRunView): number => {
  const depth = view.depth;
  return depth !== undefined && Number.isSafeInteger(depth) && depth >= 1 ? depth : 1;
};

export const isRunInSubtree = (
  records: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
  candidateRunId: string,
): boolean => {
  let current = records.get(candidateRunId);
  while (current) {
    if (current.view.id === rootRunId) return true;
    const parentRunId = parentIdOf(current.view);
    if (parentRunId === SUBAGENT_ROOT_RUN_ID) return false;
    current = records.get(parentRunId);
  }
  return false;
};

/** Deepest runs first, so a shutdown closes every descendant before its ancestor. */
export const leafFirst = (records: Iterable<RunRecord>): ReadonlyArray<RunRecord> =>
  [...records].sort((left, right) => runDepth(right.view) - runDepth(left.view));

/** Leaf-first descendant ids of `rootRunId`, excluding the root itself. */
export const descendantRunIds = (
  records: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
): ReadonlyArray<string> =>
  leafFirst(
    [...records.values()].filter(
      (record) =>
        rootRunId === SUBAGENT_ROOT_RUN_ID ||
        (record.view.id !== rootRunId && isRunInSubtree(records, rootRunId, record.view.id)),
    ),
  ).map((record) => record.view.id);

export const projectRunTree = (
  records: ReadonlyMap<string, RunRecord>,
): ReadonlyArray<SubagentRunView> => {
  const directCounts = new Map<string, number>();
  const descendantCounts = new Map<string, number>();
  for (const record of records.values()) {
    const parentRunId = parentIdOf(record.view);
    directCounts.set(parentRunId, (directCounts.get(parentRunId) ?? 0) + 1);
    let currentParent = parentRunId;
    while (currentParent !== SUBAGENT_ROOT_RUN_ID) {
      descendantCounts.set(currentParent, (descendantCounts.get(currentParent) ?? 0) + 1);
      const parent = records.get(currentParent);
      if (!parent) break;
      currentParent = parentIdOf(parent.view);
    }
  }
  // Each row shares its view's memoized frozen snapshot and freezes only its own envelope.
  return [...records.values()].map(
    (record): SubagentRunView =>
      Object.freeze({
        ...snapshotView(record.view),
        parentRunId: parentIdOf(record.view),
        depth: runDepth(record.view),
        directChildCount: directCounts.get(record.view.id) ?? 0,
        descendantCount: descendantCounts.get(record.view.id) ?? 0,
      }),
  );
};
