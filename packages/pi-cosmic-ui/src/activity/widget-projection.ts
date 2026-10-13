import type { Theme } from "@earendil-works/pi-coding-agent";
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
  const failures = checklist(rows).filter(isFailedEntry).length;
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
  const tree = all.flatMap((entry): GroupedActivityRow[] => {
    const suppressed = entry.parentId !== undefined && hiddenDetail.has(entry.parentId);
    const collapsed = options.collapsed?.has(entry.id);
    if (!suppressed && !collapsed) return [entry];
    hiddenDetail.add(entry.id);
    if (entry.type === "member" && suppressed) return [];
    return [{ ...entry, expanded: false }];
  });
  const slots = tree
    .filter((entry) => entry.type === "section")
    .map((heading) => {
      const candidates = tree.filter(inSection(heading));
      const offered = all.filter(inSection(heading));
      return { heading, candidates, offered, allocated: 0 };
    });
  const budget = Math.max(0, maxRows - Number(needsYou(rows).length > 0));
  let used = slots.filter((slot) => slot.offered.length > 0).length;
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
  return slots.map(({ heading, candidates, offered, allocated }) => {
    const entries = candidates.slice(0, allocated);
    return { heading, entries, omittedRows: offered.length - entries.length };
  });
}
