import type { SubagentRunView } from "../run/model.ts";

export interface RunTreeNode {
  readonly id: string;
  readonly parentRunId?: string | undefined;
}

export interface RunTreeRow<Node extends RunTreeNode> {
  readonly run: Node;
  readonly isLastSibling: boolean;
  /** For each ancestor, whether its connector continues through this row. */
  readonly ancestorContinues: ReadonlyArray<boolean>;
}

interface RunTreeWalkRow<Node extends RunTreeNode> extends RunTreeRow<Node> {
  readonly hasChildren: boolean;
  /** True when a collapsed ancestor hides this row. */
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

/**
 * Depth-first parent-before-child walk from `roots` over a prepared children map. Each id is
 * visited at most once across calls that share `visited`; sibling order and last-sibling
 * status follow the children map even when a sibling is skipped. Descendants of a collapsed
 * run are still visited, flagged hidden.
 */
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
    descendants.forEach((child, index) =>
      descend(
        child,
        index === descendants.length - 1,
        [...ancestorContinues, !isLastSibling],
        hideChildren,
      ),
    );
  };
  roots.forEach((run, index) => descend(run, index === roots.length - 1, [], false));
};

/**
 * Parent-before-child projection over a bounded card set. Duplicate ids keep their first card;
 * cards whose parent is missing, unknown, or themselves become roots; cycle members that never
 * reach a root are surfaced as roots so every card renders exactly once.
 */
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

export interface FleetTreeProjection<Node extends RunTreeNode = SubagentRunView> {
  /** Every run inside the authenticated subtree, including descendants hidden by collapse. */
  readonly runs: ReadonlyArray<Node>;
  /** Parent-before-child rows currently visible in the manager. */
  readonly rows: ReadonlyArray<FleetTreeRow<Node>>;
}

/**
 * Projects a bounded run snapshot into one expandable, parent-before-child hierarchy scoped to
 * `visibilityRootId`. The virtual root (or nested caller identity) is a scope boundary, never a
 * rendered row, and runs outside that subtree are dropped rather than promoted.
 */
export const projectFleetTree = <Node extends RunTreeNode = SubagentRunView>(
  runs: ReadonlyArray<Node>,
  visibilityRootId: string,
  collapsedRunIds: ReadonlySet<string>,
): FleetTreeProjection<Node> => {
  const children = new Map<string, Node[]>();
  for (const run of runs) addChild(children, run.parentRunId ?? "root", run);

  const scopedRuns: Node[] = [];
  const rows: FleetTreeRow<Node>[] = [];
  // Pre-visiting the root keeps it out of the rows even if a cycle points back at it.
  const visited = new Set<string>([visibilityRootId]);
  walkRunTree(children.get(visibilityRootId) ?? [], children, visited, collapsedRunIds, (row) => {
    scopedRuns.push(row.run);
    // A collapsed ancestor hides this row while keeping it inside the scoped run set.
    if (row.hidden) return;
    rows.push({
      run: row.run,
      isLastSibling: row.isLastSibling,
      ancestorContinues: row.ancestorContinues,
      hasChildren: row.hasChildren,
      expanded: row.hasChildren && !collapsedRunIds.has(row.run.id),
    });
  });
  return { runs: scopedRuns, rows };
};

/** Box-drawing connector prefix shared by tool cards and the fleet manager. */
export const runTreeBranch = <Node extends RunTreeNode>(row: RunTreeRow<Node>): string =>
  `${row.ancestorContinues.map((continued) => (continued ? "│   " : "    ")).join("")}${
    row.isLastSibling ? "└── " : "├── "
  }`;
