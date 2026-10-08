import { activityKey, type ActivityItem } from "./protocol.ts";

export type ActivityRow = ActivityItem & {
  readonly key: string;
  readonly providerId: string;
  readonly generation: number;
  /** Historical summary only: the current provider no longer exposes this item. */
  readonly retained?: true;
  /** Lower bounds, not exact lifetime totals. Repeated snapshots never inflate them. */
  readonly omittedChildren?: number;
};
export const isFinished = (item: Pick<ActivityItem, "status">): boolean =>
  item.status === "done" || item.status === "failed" || item.status === "cancelled";
export const COMPLETED_BRANCH_LIMIT = 128;
const COMPLETED_TOTAL_LIMIT = 1024;
const HISTORY_ROOT_LIMIT = 100;
const endedAt = (row: ActivityRow) => row.endedAt ?? row.updatedAt ?? 0;

/** Missing owners and every path entering a cycle become roots. Package-private. */
export function resolveActivityOwnership(byKey: ReadonlyMap<string, ActivityRow>) {
  const parents = new Map<string, string>();
  const roots = new Map<string, string>();
  for (const row of byKey.values()) {
    const seen = new Set<string>();
    let cursor = row;
    while (cursor.parent && !seen.has(cursor.key)) {
      seen.add(cursor.key);
      const owner = byKey.get(activityKey(cursor.parent.providerId, cursor.parent.itemId));
      if (!owner) break;
      cursor = owner;
    }
    const cycle =
      seen.has(cursor.key) &&
      cursor.parent !== undefined &&
      byKey.has(activityKey(cursor.parent.providerId, cursor.parent.itemId));
    roots.set(row.key, cycle ? row.key : cursor.key);
    if (!cycle && row.parent) {
      const parent = activityKey(row.parent.providerId, row.parent.itemId);
      if (byKey.has(parent)) parents.set(row.key, parent);
    }
  }
  return { parents, roots };
}

/** Retain completed summaries, but not their expired actions. Never prune live rows or their ancestors. */
export function retainActivity(
  previous: readonly ActivityRow[],
  current: readonly ActivityRow[],
): readonly ActivityRow[] {
  const old = new Map(previous.map((row) => [row.key, row]));
  const next = new Map(current.map((row) => [row.key, row]));
  for (const row of previous)
    if (!next.has(row.key) && isFinished(row))
      next.set(row.key, { ...row, retained: true, actions: [], awaited: false });
  const rows = [...next.values()];
  const { parents, roots } = resolveActivityOwnership(next);
  const protectedKeys = new Set<string>();
  for (const row of rows.filter((value) => !isFinished(value) || value.awaited)) {
    let key: string | undefined = row.key;
    while (key && !protectedKeys.has(key)) {
      protectedKeys.add(key);
      key = parents.get(key);
    }
  }
  const history = rows.filter((row) => !parents.has(row.key) && !protectedKeys.has(row.key));
  // Each publication puts the rows its sources just dropped ahead of older retained rows, so
  // reversed retained rows go longest-dropped first; rows still published go earliest ended first.
  const evictionOrder = [
    ...history.filter((row) => row.retained).reverse(),
    ...history.filter((row) => !row.retained).sort((left, right) => endedAt(left) - endedAt(right)),
  ];
  const evictedRoots = new Set(
    evictionOrder.slice(0, Math.max(0, history.length - HISTORY_ROOT_LIMIT)).map((row) => row.key),
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
  // Work that never ran goes before real results: its producer's planned counts still cover it.
  queue.sort(
    (left, right) =>
      Number(left.planned !== true) - Number(right.planned !== true) ||
      endedAt(left) - endedAt(right),
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
    // Omissions count finished items; planned work never ran and is counted as planned instead.
    if (row.planned !== true) omitted.set(root, (omitted.get(root) ?? 0) + 1);
    const parent = parents.get(row.key);
    if (parent) {
      childCounts.set(parent, (childCounts.get(parent) ?? 1) - 1);
      const owner = next.get(parent)!;
      if (!childCounts.get(parent) && isFinished(owner) && !protectedKeys.has(parent))
        queue.push(owner);
    }
  }
  return rows
    .filter((row) => keep.has(row.key))
    .map((row) => {
      const omittedChildren = Math.max(
        omitted.get(row.key) ?? 0,
        old.get(row.key)?.omittedChildren ?? 0,
      );
      return { ...row, ...(omittedChildren > 0 && { omittedChildren }) };
    });
}

/** A row's ownership path, root first, through the same resolved owners as the tree. */
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
