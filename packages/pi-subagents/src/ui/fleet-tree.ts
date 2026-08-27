import type { SubagentRunView } from "../run/model.ts";

export interface FleetTreeRow {
  readonly run: SubagentRunView;
  /** Zero-based depth relative to the manager's authenticated visibility root. */
  readonly depth: number;
  readonly isLastSibling: boolean;
  /** For each ancestor, whether its connector continues through this row. */
  readonly ancestorContinues: ReadonlyArray<boolean>;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

export interface FleetTreeProjection {
  /** Every run inside the authenticated subtree, including descendants hidden by collapse. */
  readonly runs: ReadonlyArray<SubagentRunView>;
  /** Parent-before-child rows currently visible in the manager. */
  readonly rows: ReadonlyArray<FleetTreeRow>;
}

/**
 * Projects a bounded run snapshot into one expandable, parent-before-child hierarchy.
 * The virtual root (or nested caller identity) is a scope boundary, never a rendered row.
 */
export const projectFleetTree = (
  runs: ReadonlyArray<SubagentRunView>,
  visibilityRootId: string,
  collapsedRunIds: ReadonlySet<string>,
): FleetTreeProjection => {
  const children = new Map<string, SubagentRunView[]>();
  for (const run of runs) {
    const parentRunId = run.parentRunId ?? "root";
    const siblings = children.get(parentRunId);
    if (siblings) siblings.push(run);
    else children.set(parentRunId, [run]);
  }

  const scopedRuns: SubagentRunView[] = [];
  const rows: FleetTreeRow[] = [];
  const visited = new Set<string>();
  const visit = (
    run: SubagentRunView,
    depth: number,
    isLastSibling: boolean,
    ancestorContinues: ReadonlyArray<boolean>,
    visible: boolean,
  ): void => {
    if (run.id === visibilityRootId || !visited.add(run.id)) return;
    scopedRuns.push(run);
    const descendants = children.get(run.id) ?? [];
    const hasChildren = descendants.length > 0;
    const expanded = hasChildren && !collapsedRunIds.has(run.id);
    if (visible)
      rows.push({
        run,
        depth,
        isLastSibling,
        ancestorContinues,
        hasChildren,
        expanded,
      });
    descendants.forEach((child, index) =>
      visit(
        child,
        depth + 1,
        index === descendants.length - 1,
        [...ancestorContinues, !isLastSibling],
        visible && expanded,
      ),
    );
  };

  const roots = children.get(visibilityRootId) ?? [];
  roots.forEach((run, index) => visit(run, 0, index === roots.length - 1, [], true));
  return { runs: scopedRuns, rows };
};

export const fleetTreeBranch = (row: FleetTreeRow): string =>
  `${row.ancestorContinues.map((continued) => (continued ? "│   " : "    ")).join("")}${
    row.isLastSibling ? "└── " : "├── "
  }`;
