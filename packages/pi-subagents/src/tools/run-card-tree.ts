export interface RunTreeNode {
  readonly id: string;
  readonly parentRunId?: string | undefined;
}

export interface RunTreeRow<Node extends RunTreeNode> {
  readonly run: Node;
  readonly isLastSibling: boolean;
  readonly ancestorContinues: ReadonlyArray<boolean>;
  readonly hasChildren: boolean;
}

/** Parent-before-child projection over a bounded card set; incomplete parents become roots. */
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
    if (!parentRunId || parentRunId === run.id || !byId.has(parentRunId)) {
      roots.push(run);
      continue;
    }
    const siblings = children.get(parentRunId);
    if (siblings) siblings.push(run);
    else children.set(parentRunId, [run]);
  }

  const rows: RunTreeRow<Node>[] = [];
  const visited = new Set<string>();
  const visit = (
    run: Node,
    isLastSibling: boolean,
    ancestorContinues: ReadonlyArray<boolean>,
  ): void => {
    if (visited.has(run.id)) return;
    visited.add(run.id);
    const descendants = children.get(run.id) ?? [];
    rows.push({ run, isLastSibling, ancestorContinues, hasChildren: descendants.length > 0 });
    descendants.forEach((child, index) =>
      visit(child, index === descendants.length - 1, [...ancestorContinues, !isLastSibling]),
    );
  };
  roots.forEach((run, index) => visit(run, index === roots.length - 1, []));
  for (const run of uniqueRuns) if (!visited.has(run.id)) visit(run, true, []);
  return rows;
};

const ancestorRail = <Node extends RunTreeNode>(row: RunTreeRow<Node>): string =>
  row.ancestorContinues.map((continued) => (continued ? "│   " : "    ")).join("");

export const runCardTreeBranch = <Node extends RunTreeNode>(row: RunTreeRow<Node>): string =>
  `${ancestorRail(row)}${row.isLastSibling ? "└── " : "├── "}`;

export interface RunTreeMetadataBranch {
  readonly prefix: string;
}

/** Metadata indentation beneath one tree row while preserving sibling and child continuations. */
export const runCardTreeMetadataBranch = <Node extends RunTreeNode>(
  row: RunTreeRow<Node>,
): RunTreeMetadataBranch => ({
  prefix: `${ancestorRail(row)}${row.isLastSibling ? "    " : "│   "}${row.hasChildren ? "│  " : "   "}`,
});
