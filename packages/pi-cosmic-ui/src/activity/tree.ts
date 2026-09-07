import {
  activityAttention,
  activityAttentionCounts,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { isFinished, resolveActivityOwnership, type ActivityRow } from "./model.ts";

export interface ActivityTreeRow {
  readonly row: ActivityRow;
  readonly depth: number;
  readonly children: number;
  readonly history: boolean;
  /** Each level records whether another sibling follows that ancestor. */
  readonly continuations: readonly boolean[];
  readonly expanded: boolean;
  readonly attention: ActivityAttentionCounts;
}
interface ActivityBranchSummary extends ActivityAttentionCounts {
  readonly finished: boolean;
}

export interface ActivityTreeOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly focus?: string;
  readonly hideHistory?: boolean;
}

export function activityPath(rows: readonly ActivityRow[], key: string): readonly ActivityRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const { parents } = resolveActivityOwnership(byKey);
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
  const { parents } = resolveActivityOwnership(byKey);
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
      ...activityAttentionCounts(row),
      finished: isFinished(row) && !row.awaited,
    };
    for (const child of children.get(row.key) ?? []) {
      const summary = summarize(child);
      if (options.hideHistory && summary.finished) continue;
      total.user += summary.user;
      total.parent += summary.parent;
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
    const owned = (children.get(row.key) ?? []).filter(
      (child) => !options.hideHistory || !branchFinished(child),
    );
    const expanded =
      owned.length > 0 &&
      !options.collapsed?.has(row.key) &&
      !(depth === 0 && history && !options.expandedHistory?.has(row.key));
    const summary = summarize(row);
    const own = activityAttentionCounts(row);
    const attention = {
      user: summary.user - own.user,
      parent: summary.parent - own.parent,
      blocked: summary.blocked - own.blocked,
      failed: summary.failed - own.failed,
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
  if (!options.hideHistory) for (const root of roots.filter(branchFinished)) visit(root, [], true);
  return result;
}

export const needsYou = (rows: readonly ActivityRow[]): readonly ActivityRow[] =>
  rows.filter((row) => activityAttention(row) === "user");
