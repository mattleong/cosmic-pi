import { snapshotRun, type RunRecord } from "./internal.ts";
import { isTerminalRunState, SUBAGENT_ROOT_RUN_ID, type SubagentRunView } from "./model.ts";

const parentIdOf = (view: Pick<SubagentRunView, "parentRunId">): string =>
  view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;

const runDepth = (view: Pick<SubagentRunView, "depth">): number => {
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

/** Whether an explicit stop of the run or one of its ancestors is still closing it. */
export const isStopInProgress = (
  records: ReadonlyMap<string, RunRecord>,
  record: RunRecord,
): boolean => {
  let current: RunRecord | undefined = record;
  while (current) {
    if (current.stoppedByParent && !isTerminalRunState(current.view.state)) return true;
    const parentRunId = parentIdOf(current.view);
    if (parentRunId === SUBAGENT_ROOT_RUN_ID) return false;
    current = records.get(parentRunId);
  }
  return false;
};

export const leafFirst = (records: Iterable<RunRecord>): ReadonlyArray<RunRecord> =>
  [...records].toSorted((left, right) => runDepth(right.view) - runDepth(left.view));

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
  return [...records.values()].map(
    (record): SubagentRunView =>
      Object.freeze({
        ...snapshotRun(record),
        parentRunId: parentIdOf(record.view),
        depth: runDepth(record.view),
        directChildCount: directCounts.get(record.view.id) ?? 0,
        descendantCount: descendantCounts.get(record.view.id) ?? 0,
      }),
  );
};
