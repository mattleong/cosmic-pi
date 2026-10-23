import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import { needsYou } from "./attention.ts";
import type { ActivityRow } from "./model.ts";
import { groupedActivityTree, type GroupedActivityRow } from "./grouped-tree.ts";

export interface WidgetOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly starting?: number;
  readonly now?: number;
  readonly theme?: Pick<Theme, "fg">;
}
export interface ActivityWidgetSection {
  readonly heading: GroupedActivityRow;
  readonly entries: readonly GroupedActivityRow[];
  readonly omittedRows: number;
}

const isFailedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.status === "failed";

const checklists = new WeakMap<readonly ActivityRow[], readonly GroupedActivityRow[]>();
const checklist = (rows: readonly ActivityRow[]): readonly GroupedActivityRow[] => {
  const cached = checklists.get(rows);
  if (cached) return cached;
  const tree = groupedActivityTree(rows, { hideHistory: true });
  checklists.set(rows, tree);
  return tree;
};

export function activityWidgetHeight(rows: readonly ActivityRow[], terminalRows: number): number {
  const failures = Arr.filter(checklist(rows), isFailedEntry).length;
  return Math.max(1, Math.min(Math.floor(terminalRows / 2), Math.max(8, failures + 4)));
}

const inSection = (heading: GroupedActivityRow) => (entry: GroupedActivityRow) =>
  entry.type !== "section" && entry.section === heading.section;

export function activityWidgetSections(
  rows: readonly ActivityRow[],
  maxRows = 8,
  options: WidgetOptions = {},
): readonly ActivityWidgetSection[] {
  const all = checklist(rows);
  const hiddenDetail = new Set<string>();
  const tree = Arr.flatMap(all, (entry): GroupedActivityRow[] => {
    const suppressed = entry.parentId !== undefined && hiddenDetail.has(entry.parentId);
    const collapsed = options.collapsed?.has(entry.id);
    if (!suppressed && !collapsed) return [entry];
    hiddenDetail.add(entry.id);
    if (entry.type === "member" && suppressed) return [];
    return [{ ...entry, expanded: false }];
  });
  const slots = Arr.map(
    Arr.filter(tree, (entry) => entry.type === "section"),
    (heading) => {
      const candidates = Arr.filter(tree, inSection(heading));
      const offered = Arr.filter(all, inSection(heading));
      return { heading, candidates, offered, allocated: 0 };
    },
  );
  const budget = Math.max(0, maxRows - Number(needsYou(rows).length > 0));
  let used = Arr.filter(slots, (slot) => slot.offered.length > 0).length;
  while (true) {
    let changed = false;
    for (const slot of slots) {
      const next = slot.allocated + 1;
      if (next > slot.candidates.length) continue;
      const cost = next === slot.offered.length ? 0 : 1;
      if (used + cost > budget) continue;
      slot.allocated = next;
      used += cost;
      changed = true;
    }
    if (!changed) break;
  }
  return Arr.map(slots, ({ heading, candidates, offered, allocated }) => {
    const entries = candidates.slice(0, allocated);
    return { heading, entries, omittedRows: offered.length - entries.length };
  });
}
