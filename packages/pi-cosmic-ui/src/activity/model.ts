import { activityKey, type ActivityItem } from "./protocol.ts";

export interface ActivityRow extends ActivityItem {
  readonly key: string;
  readonly providerId: string;
  readonly generation: number;
  /** Lower bounds, not exact lifetime totals. Repeated snapshots never inflate them. */
  readonly omittedChildren?: number;
  readonly omittedHistory?: number;
}
export const isFinished = (item: Pick<ActivityItem, "status">): boolean =>
  item.status === "done" || item.status === "failed" || item.status === "cancelled";
export const COMPLETED_BRANCH_LIMIT = 128;
export const COMPLETED_TOTAL_LIMIT = 1024;
export const HISTORY_ROOT_LIMIT = 100;

/** Retain completed summaries, but not their expired actions. Never prune live rows or their ancestors. */
export function retainActivity(
  previous: readonly ActivityRow[],
  current: readonly ActivityRow[],
): readonly ActivityRow[] {
  const old = new Map(previous.map((row) => [row.key, row]));
  const next = new Map(current.map((row) => [row.key, row]));
  for (const row of previous)
    if (!next.has(row.key) && isFinished(row)) next.set(row.key, { ...row, actions: [] });
  const rows = [...next.values()];
  const parents = new Map<string, string>();
  const roots = new Map<string, string>();
  for (const row of rows) {
    const seen = new Set<string>();
    let cursor = row;
    while (cursor.parent && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      const owner = next.get(activityKey(cursor.parent.providerId, cursor.parent.itemId));
      if (!owner) break;
      cursor = owner;
    }
    const cycle =
      seen.has(cursor.key) &&
      cursor.parent !== undefined &&
      next.has(activityKey(cursor.parent.providerId, cursor.parent.itemId));
    roots.set(row.key, cycle ? row.key : cursor.key);
    if (!cycle && row.parent) {
      const parent = activityKey(row.parent.providerId, row.parent.itemId);
      if (next.has(parent)) parents.set(row.key, parent);
    }
  }
  const protectedKeys = new Set<string>();
  for (const row of rows.filter((value) => !isFinished(value))) {
    let key: string | undefined = row.key;
    while (key && !protectedKeys.has(key)) {
      protectedKeys.add(key);
      key = parents.get(key);
    }
  }
  const history = rows.filter((row) => !parents.has(row.key) && !protectedKeys.has(row.key));
  const evictedRoots = new Set(
    history.slice(0, Math.max(0, history.length - HISTORY_ROOT_LIMIT)).map((row) => row.key),
  );
  const keep = new Set(
    rows.filter((row) => !evictedRoots.has(roots.get(row.key)!)).map((row) => row.key),
  );
  const childCounts = new Map<string, number>();
  const branchCounts = new Map<string, number>();
  let completed = 0;
  for (const row of rows) {
    if (!keep.has(row.key)) continue;
    const parent = parents.get(row.key);
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
    if (isFinished(row) && !protectedKeys.has(row.key)) {
      completed++;
      const root = roots.get(row.key)!;
      branchCounts.set(root, (branchCounts.get(root) ?? 0) + 1);
    }
  }
  const omitted = new Map<string, number>();
  const queue = rows.filter(
    (row) =>
      keep.has(row.key) &&
      isFinished(row) &&
      !protectedKeys.has(row.key) &&
      !childCounts.get(row.key),
  );
  queue.sort(
    (left, right) =>
      (left.endedAt ?? left.updatedAt ?? 0) - (right.endedAt ?? right.updatedAt ?? 0),
  );
  for (let index = 0; index < queue.length; index++) {
    const row = queue[index]!;
    const root = roots.get(row.key)!;
    if (
      completed <= COMPLETED_TOTAL_LIMIT &&
      (branchCounts.get(root) ?? 0) <= COMPLETED_BRANCH_LIMIT
    )
      continue;
    keep.delete(row.key);
    completed--;
    branchCounts.set(root, (branchCounts.get(root) ?? 1) - 1);
    omitted.set(root, (omitted.get(root) ?? 0) + 1);
    const parent = parents.get(row.key);
    if (parent) {
      childCounts.set(parent, (childCounts.get(parent) ?? 1) - 1);
      const owner = next.get(parent)!;
      if (!childCounts.get(parent) && isFinished(owner) && !protectedKeys.has(parent))
        queue.push(owner);
    }
  }
  const retained = rows.filter((row) => keep.has(row.key));
  const omittedHistory = Math.max(
    evictedRoots.size,
    ...previous.map((row) => row.omittedHistory ?? 0),
  );
  return Object.freeze(
    retained.map((row, index) => {
      const detached = { ...row };
      const omittedChildren = Math.max(
        omitted.get(row.key) ?? 0,
        old.get(row.key)?.omittedChildren ?? 0,
      );
      if (omittedChildren) Object.assign(detached, { omittedChildren });
      if (index === 0 && omittedHistory) Object.assign(detached, { omittedHistory });
      return Object.freeze(detached);
    }),
  );
}
