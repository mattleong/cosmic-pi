import { activityAttention, type ActivityAttentionCounts } from "./attention.ts";
import { resolveActivityOwnership, type ActivityRow } from "./model.ts";

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

export const needsYou = (rows: readonly ActivityRow[]): readonly ActivityRow[] =>
  rows.filter((row) => activityAttention(row) === "user");
