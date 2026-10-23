import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import type { SubagentRunView } from "../run/model.ts";

interface RunTreeNode {
  readonly id: string;
  readonly parentRunId?: string | undefined;
}

interface RunTreeRow<Node extends RunTreeNode> {
  readonly run: Node;
  readonly isLastSibling: boolean;
  readonly ancestorContinues: ReadonlyArray<boolean>;
}

interface RunTreeWalkRow<Node extends RunTreeNode> extends RunTreeRow<Node> {
  readonly hasChildren: boolean;
  readonly hidden: boolean;
}

const NO_COLLAPSE: ReadonlySet<string> = new Set();

const addChild = <Node extends RunTreeNode>(
  children: Map<string, Node[]>,
  parentRunId: string,
  run: Node,
): void => {
  const siblings = children.get(parentRunId);
  if (siblings) siblings.push(run);
  else children.set(parentRunId, [run]);
};

const walkRunTree = <Node extends RunTreeNode>(
  roots: ReadonlyArray<Node>,
  children: ReadonlyMap<string, ReadonlyArray<Node>>,
  visited: Set<string>,
  collapsedRunIds: ReadonlySet<string>,
  visit: (row: RunTreeWalkRow<Node>) => void,
): void => {
  const descend = (
    run: Node,
    isLastSibling: boolean,
    ancestorContinues: ReadonlyArray<boolean>,
    hidden: boolean,
  ): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    const descendants = children.get(run.id) ?? [];
    visit({ run, isLastSibling, ancestorContinues, hasChildren: descendants.length > 0, hidden });
    const hideChildren = hidden || collapsedRunIds.has(run.id);
    Arr.forEach(descendants, (child, index) =>
      descend(
        child,
        index === descendants.length - 1,
        [...ancestorContinues, !isLastSibling],
        hideChildren,
      ),
    );
  };
  Arr.forEach(roots, (run, index) => descend(run, index === roots.length - 1, [], false));
};

export const projectRunCardTree = <Node extends RunTreeNode>(
  runs: ReadonlyArray<Node>,
): ReadonlyArray<RunTreeRow<Node>> => {
  const byId = new Map<string, Node>();
  for (const run of runs) if (!byId.has(run.id)) byId.set(run.id, run);
  const uniqueRuns = [...byId.values()];
  const children = new Map<string, Node[]>();
  const roots: Node[] = [];
  for (const run of uniqueRuns) {
    const parentRunId = run.parentRunId;
    if (!parentRunId || parentRunId === run.id || !byId.has(parentRunId)) roots.push(run);
    else addChild(children, parentRunId, run);
  }

  const rows: RunTreeRow<Node>[] = [];
  const visited = new Set<string>();
  const collect = ({ run, isLastSibling, ancestorContinues }: RunTreeWalkRow<Node>): void => {
    rows.push({ run, isLastSibling, ancestorContinues });
  };
  walkRunTree(roots, children, visited, NO_COLLAPSE, collect);
  for (const run of uniqueRuns)
    if (!visited.has(run.id)) walkRunTree([run], children, visited, NO_COLLAPSE, collect);
  return rows;
};

export interface FleetTreeRow<Node extends RunTreeNode = SubagentRunView> extends RunTreeRow<Node> {
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

interface FleetTreeProjection<Node extends RunTreeNode = SubagentRunView> {
  readonly runs: ReadonlyArray<Node>;
  readonly rows: ReadonlyArray<FleetTreeRow<Node>>;
}

export const projectFleetTree = <Node extends RunTreeNode = SubagentRunView>(
  runs: ReadonlyArray<Node>,
  visibilityRootId: string,
  collapsedRunIds: ReadonlySet<string> = NO_COLLAPSE,
): FleetTreeProjection<Node> => {
  const children = new Map<string, Node[]>();
  for (const run of runs) addChild(children, run.parentRunId ?? "root", run);

  const scopedRuns: Node[] = [];
  const rows: FleetTreeRow<Node>[] = [];
  const visited = new Set<string>([visibilityRootId]);
  const roots = children.get(visibilityRootId) ?? [];
  walkRunTree(roots, children, visited, collapsedRunIds, ({ hidden, ...row }) => {
    scopedRuns.push(row.run);
    if (!hidden)
      rows.push({ ...row, expanded: row.hasChildren && !collapsedRunIds.has(row.run.id) });
  });
  return { runs: scopedRuns, rows };
};

export const runTreeBranch = <Node extends RunTreeNode>(row: RunTreeRow<Node>): string =>
  `${Fn.pipe(
    row.ancestorContinues,
    Arr.map((continued) => (continued ? "│   " : "    ")),
    Arr.join(""),
  )}${row.isLastSibling ? "└── " : "├── "}`;
