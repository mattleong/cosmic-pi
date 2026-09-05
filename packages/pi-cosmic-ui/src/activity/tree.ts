import { activityKey } from "./protocol.ts";
import { isFinished, type ActivityRow } from "./model.ts";

export interface ActivityTreeRow {
  readonly row: ActivityRow;
  readonly depth: number;
  readonly children: number;
  readonly history: boolean;
  /** Each level records whether another sibling follows that ancestor. */
  readonly continuations: readonly boolean[];
  readonly expanded: boolean;
  readonly attention: {
    readonly waiting: number;
    readonly blocked: number;
    readonly failed: number;
  };
}
interface ActivityBranchSummary {
  readonly waiting: number;
  readonly blocked: number;
  readonly failed: number;
  readonly finished: boolean;
}

export interface ActivityTreeOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly focus?: string;
}

/** Missing owners and cyclic ownership are roots, never inferred from timing or titles. */
function activityParents(rows: readonly ActivityRow[]): ReadonlyMap<string, string> {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const parents = new Map<string, string>();
  for (const row of rows) {
    if (!row.parent) continue;
    const parent = activityKey(row.parent.providerId, row.parent.itemId);
    if (!byKey.has(parent)) continue;
    const seen = new Set([row.key]);
    let cursor: string | undefined = parent;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const owner: ActivityRow["parent"] = byKey.get(cursor)?.parent;
      cursor = owner ? activityKey(owner.providerId, owner.itemId) : undefined;
    }
    if (!cursor) parents.set(row.key, parent);
  }
  return parents;
}

export function activityPath(rows: readonly ActivityRow[], key: string): readonly ActivityRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const parents = activityParents(rows);
  const path: ActivityRow[] = [];
  let cursor = byKey.get(key);
  while (cursor) {
    path.unshift(cursor);
    const parent = parents.get(cursor.key);
    cursor = parent ? byKey.get(parent) : undefined;
  }
  return path;
}

export function activityTree(
  rows: readonly ActivityRow[],
  options: ActivityTreeOptions = {},
): readonly ActivityTreeRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const parents = activityParents(rows);
  const children = new Map<string, ActivityRow[]>();
  for (const row of rows) {
    const parent = parents.get(row.key);
    if (parent) children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const summaries = new Map<string, ActivityBranchSummary>();
  const summarize = (row: ActivityRow): ActivityBranchSummary => {
    const cached = summaries.get(row.key);
    if (cached) return cached;
    const total = {
      waiting: Number(row.status === "needs-input"),
      blocked: Number(row.status === "blocked"),
      failed: Number(row.status === "failed"),
      finished: isFinished(row),
    };
    for (const child of children.get(row.key) ?? []) {
      const summary = summarize(child);
      total.waiting += summary.waiting;
      total.blocked += summary.blocked;
      total.failed += summary.failed;
      total.finished &&= summary.finished;
    }
    summaries.set(row.key, total);
    return total;
  };
  const branchFinished = (row: ActivityRow): boolean => summarize(row).finished;
  const roots =
    options.focus && byKey.has(options.focus)
      ? [byKey.get(options.focus)!]
      : rows.filter((row) => !parents.has(row.key));
  const result: ActivityTreeRow[] = [];
  const visit = (row: ActivityRow, continuations: readonly boolean[], history: boolean) => {
    const depth = continuations.length;
    const owned = children.get(row.key) ?? [];
    const expanded =
      owned.length > 0 &&
      !options.collapsed?.has(row.key) &&
      !(depth === 0 && history && !options.expandedHistory?.has(row.key));
    const summary = summarize(row);
    const attention = {
      waiting: summary.waiting - Number(row.status === "needs-input"),
      blocked: summary.blocked - Number(row.status === "blocked"),
      failed: summary.failed - Number(row.status === "failed"),
    };
    result.push({
      row,
      depth,
      children: owned.length,
      history,
      continuations,
      expanded,
      attention,
    });
    if (!expanded) return;
    owned.forEach((child, index) =>
      visit(child, [...continuations, index < owned.length - 1], history),
    );
  };
  for (const root of roots.filter((row) => !branchFinished(row))) visit(root, [], false);
  for (const root of roots.filter(branchFinished)) visit(root, [], true);
  return result;
}

export const needsYou = (rows: readonly ActivityRow[]): readonly ActivityRow[] =>
  rows.filter((row) => row.status === "needs-input");
