import * as Arr from "effect/Array";
import * as Order from "effect/Order";
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
  Arr.sort(
    records,
    Order.mapInput(Order.flip(Order.Number), (record: RunRecord) => runDepth(record.view)),
  );

export const descendantRunIds = (
  records: ReadonlyMap<string, RunRecord>,
  rootRunId: string,
): ReadonlyArray<string> =>
  Arr.map(
    leafFirst(
      Arr.filter(
        [...records.values()],
        (record) =>
          rootRunId === SUBAGENT_ROOT_RUN_ID ||
          (record.view.id !== rootRunId && isRunInSubtree(records, rootRunId, record.view.id)),
      ),
    ),
    (record) => record.view.id,
  );

interface RunTreeView {
  readonly directChildCount: number;
  readonly descendantCount: number;
  readonly view: SubagentRunView;
}

// Keyed by the run's frozen snapshot, so an unchanged run keeps its tree view across projections.
const runTreeViews = new WeakMap<SubagentRunView, RunTreeView>();

/** A run's frozen snapshot with its place in the tree; the snapshot's nested values stay shared. */
export const runTreeView = (
  snapshot: SubagentRunView,
  directChildCount: number,
  descendantCount: number,
): SubagentRunView => {
  const cached = runTreeViews.get(snapshot);
  if (cached?.directChildCount === directChildCount && cached.descendantCount === descendantCount)
    return cached.view;
  const view: SubagentRunView = Object.freeze({
    ...snapshot,
    parentRunId: parentIdOf(snapshot),
    depth: runDepth(snapshot),
    directChildCount,
    descendantCount,
  });
  runTreeViews.set(snapshot, { directChildCount, descendantCount, view });
  return view;
};

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
  return Arr.map([...records.values()], (record) =>
    runTreeView(
      snapshotRun(record),
      directCounts.get(record.view.id) ?? 0,
      descendantCounts.get(record.view.id) ?? 0,
    ),
  );
};
