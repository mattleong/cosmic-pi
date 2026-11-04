import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import { activityAttention, needsYou } from "./attention.ts";
import type { ActivityRow } from "./model.ts";
import { groupedActivityTree, type GroupedActivityRow } from "./grouped-tree.ts";

export interface WidgetOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly starting?: number;
  readonly now?: number;
  readonly theme?: Pick<Theme, "fg">;
  /** A questionnaire or other input dock is on screen, so its own waiting rows need no echo. */
  readonly inputDockVisible?: boolean;
  /** Failures the user has already looked at in Activity, by `activityInspectionKey`. */
  readonly inspected?: ReadonlySet<string>;
}
export interface WidgetAllocation {
  /** Rows set aside before entries are allocated, such as a Needs-you or failure line. */
  readonly reserved?: number;
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

/** A question open on screen offers no way back to it, unlike a hidden one that offers Resume. */
const onScreenQuestion = (row: ActivityRow): boolean =>
  row.kind === "question" &&
  activityAttention(row) === "user" &&
  !Arr.some(row.actions ?? [], (action) => action.id === "resume");

const offScreen = new WeakMap<readonly ActivityRow[], readonly ActivityRow[]>();
/** The rows the widget shows; those an input dock already presents are left to it. */
export const widgetRows = (
  rows: readonly ActivityRow[],
  inputDockVisible: boolean | undefined,
): readonly ActivityRow[] => {
  if (!inputDockVisible || !Arr.some(rows, onScreenQuestion)) return rows;
  const cached = offScreen.get(rows);
  if (cached) return cached;
  const shown = Arr.filter(rows, (row) => !onScreenQuestion(row));
  offScreen.set(rows, shown);
  return shown;
};

const RECENT_FAILURE_MS = 10 * 60_000;

/** Identifies one outcome of an item, so a later failure of the same item counts as new. */
export const activityInspectionKey = (row: ActivityRow): string =>
  `${row.key}\u0000${row.generation}\u0000${row.revision}`;

const recentFailure = (row: ActivityRow, now: number | undefined): boolean =>
  now === undefined || now - (row.endedAt ?? row.updatedAt ?? now) <= RECENT_FAILURE_MS;

/**
 * Failures the live checklist no longer lists because their work has finished. They stay
 * countable until the user inspects them in Activity, or for ten minutes, so a failure never
 * silently disappears from view.
 */
export const hiddenWidgetFailures = (
  rows: readonly ActivityRow[],
  now: number | undefined,
  inspected?: ReadonlySet<string>,
): readonly ActivityRow[] => {
  const listed = new Set(
    Arr.flatMap(checklist(rows), (entry) => (entry.type === "member" ? [entry.row.key] : [])),
  );
  return Arr.filter(
    rows,
    (row) =>
      row.status === "failed" &&
      !listed.has(row.key) &&
      recentFailure(row, now) &&
      inspected?.has(activityInspectionKey(row)) !== true,
  );
};

/** Whether a clock step from `previous` to `now` retires a failure line, needing a repaint. */
export const widgetFailuresExpire = (
  rows: readonly ActivityRow[],
  previous: number,
  now: number,
): boolean =>
  Arr.some(
    rows,
    (row) => row.status === "failed" && recentFailure(row, previous) && !recentFailure(row, now),
  );

export function activityWidgetHeight(rows: readonly ActivityRow[], terminalRows: number): number {
  const failures = Arr.filter(checklist(rows), isFailedEntry).length;
  return Math.max(1, Math.min(Math.floor(terminalRows / 2), Math.max(8, failures + 4)));
}

const inSection = (heading: GroupedActivityRow) => (entry: GroupedActivityRow) =>
  entry.type !== "section" && entry.section === heading.section;

export function activityWidgetSections(
  rows: readonly ActivityRow[],
  maxRows = 8,
  options: WidgetOptions & WidgetAllocation = {},
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
  const budget = Math.max(0, maxRows - (options.reserved ?? Number(needsYou(rows).length > 0)));
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
