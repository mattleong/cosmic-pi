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
  readonly narrators: ReadonlySet<string>;
  readonly failureOverflow: ReadonlyMap<string, number>;
  readonly omittedRows: number;
  readonly hiddenSources: number;
  readonly hiddenWorkflows: number;
  readonly hiddenPhases: number;
  readonly hiddenPlanned: number;
}

const LIVE_FAILURE_ROWS = 2;

export const isPlannedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.planned === true;
const isFailedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.status === "failed";

export const workflowNarrator = (entry: GroupedActivityRow): string | undefined =>
  entry.type === "workflow" && entry.depth === 1
    ? entry.row.summary?.trim() || undefined
    : undefined;
const narratorCount = (entries: readonly GroupedActivityRow[]) =>
  entries.filter((entry) => workflowNarrator(entry) !== undefined).length;

interface WidgetSlot {
  readonly id: string;
  readonly parentId: string | undefined;
}
const narratorSlot = (workflowId: string): string => `narrator:${workflowId}`;
const failureSlot = (branchId: string): string => `failures:${branchId}`;

const failureSlots = (
  entries: readonly GroupedActivityRow[],
): ReadonlyArray<WidgetSlot & { readonly parentId: string; readonly count: number }> =>
  entries.flatMap((entry) =>
    (entry.type === "workflow" || entry.type === "phase") && entry.hiddenFailures > 0
      ? [{ id: failureSlot(entry.id), parentId: entry.id, count: entry.hiddenFailures }]
      : [],
  );
const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);
const extraLines = (entries: readonly GroupedActivityRow[]) =>
  narratorCount(entries) + failureSlots(entries).length;

const checklists = new WeakMap<readonly ActivityRow[], readonly GroupedActivityRow[]>();
const checklist = (rows: readonly ActivityRow[]): readonly GroupedActivityRow[] => {
  const cached = checklists.get(rows);
  if (cached) return cached;
  const tree = groupedActivityTree(rows, {
    hideHistory: true,
    liveFailures: LIVE_FAILURE_ROWS,
  });
  checklists.set(rows, tree);
  return tree;
};

export function activityWidgetHeight(rows: readonly ActivityRow[], terminalRows: number): number {
  const entries = checklist(rows);
  const structure =
    entries.filter(
      (entry) =>
        entry.type === "workflow" ||
        entry.type === "phase" ||
        isPlannedEntry(entry) ||
        isFailedEntry(entry),
    ).length + extraLines(entries);
  return Math.max(1, Math.min(Math.floor(terminalRows / 2), Math.max(8, structure + 4)));
}

const phasePriority = (row: GroupedActivityRow): number => {
  if (row.type !== "phase") return 2;
  const { user, parent, blocked, failed } = row.summary.attention;
  if (user + parent + blocked + failed > 0) return 0;
  return row.state === "running" ? 1 : 2;
};

function allocateWidgetRows(
  rows: readonly GroupedActivityRow[],
  budget: number,
): Pick<ActivityWidgetSection, "entries" | "narrators" | "failureOverflow"> {
  const roots = rows.filter((row) => row.type === "workflow" && row.depth === 1);
  if (!roots.length)
    return { entries: rows.slice(0, budget), narrators: new Set(), failureOverflow: new Map() };
  const selected = new Set(roots.slice(0, budget).map((row) => row.id));
  const share = (branches: readonly (readonly WidgetSlot[])[]) => {
    const cursors = branches.map((slots) => ({ slots, offset: 0 }));
    while (selected.size < budget) {
      let changed = false;
      for (const cursor of cursors) {
        if (selected.size >= budget) break;
        const row = cursor.slots[cursor.offset];
        if (!row) continue;
        if (row.parentId && !selected.has(row.parentId)) continue;
        selected.add(row.id);
        cursor.offset++;
        changed = true;
      }
      if (!changed) break;
    }
  };
  share(
    roots.map((root) =>
      rows
        .filter((row) => row.type === "phase" && row.parentId === root.id)
        .toSorted((left, right) => phasePriority(left) - phasePriority(right)),
    ),
  );
  share(
    roots.map((root) =>
      workflowNarrator(root) === undefined
        ? []
        : [{ id: narratorSlot(root.id), parentId: root.id }],
    ),
  );
  const phases = rows.filter((row) => row.type === "phase" && selected.has(row.id));
  const phaseById = new Map<string, string>(roots.map((root) => [root.id, root.id]));
  const membersByPhase = new Map<string, GroupedActivityRow[]>();
  const plannedByPhase = new Map<string, GroupedActivityRow[]>();
  const failuresByPhase = new Map<string, GroupedActivityRow[]>();
  for (const row of rows) {
    if (row.type === "phase") phaseById.set(row.id, row.id);
    else if (row.type !== "section" && row.parentId) {
      const phase = phaseById.get(row.parentId);
      if (!phase) continue;
      phaseById.set(row.id, phase);
      const byPhase = isPlannedEntry(row)
        ? plannedByPhase
        : isFailedEntry(row)
          ? failuresByPhase
          : membersByPhase;
      const members = byPhase.get(phase) ?? [];
      members.push(row);
      byPhase.set(phase, members);
    }
  }
  const branches = [...phases, ...roots];
  share(branches.map((phase) => failuresByPhase.get(phase.id) ?? []));
  const overflow = failureSlots(rows);
  share(overflow.map((slot) => [slot]));
  share(branches.map((phase) => membersByPhase.get(phase.id) ?? []));
  share(branches.map((phase) => plannedByPhase.get(phase.id) ?? []));
  const entries = rows.filter((row) => selected.has(row.id));
  const anchors = new Map<string, string>();
  for (const entry of entries)
    if (entry.parentId !== undefined && isFailedEntry(entry)) anchors.set(entry.parentId, entry.id);
  return {
    entries,
    narrators: new Set(
      roots.filter((root) => selected.has(narratorSlot(root.id))).map((root) => root.id),
    ),
    failureOverflow: new Map(
      overflow
        .filter((slot) => selected.has(slot.id))
        .map((slot) => [anchors.get(slot.parentId) ?? slot.parentId, slot.count]),
    ),
  };
}

const hiddenCount = (
  available: readonly GroupedActivityRow[],
  shown: readonly GroupedActivityRow[],
  matches: (entry: GroupedActivityRow) => boolean,
) => available.filter(matches).length - shown.filter(matches).length;
const ofType = (type: GroupedActivityRow["type"]) => (entry: GroupedActivityRow) =>
  entry.type === type;

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
    if (entry.type === "workflow") return [{ ...entry, hiddenFailures: 0 }];
    if (entry.type === "phase") return [{ ...entry, expanded: false, hiddenFailures: 0 }];
    return [{ ...entry, expanded: false }];
  });
  const inSection = (heading: GroupedActivityRow) => (entry: GroupedActivityRow) =>
    entry.type !== "section" && entry.section === heading.section;
  const slots = tree
    .filter((entry) => entry.type === "section")
    .map((heading) => {
      const candidates = tree.filter(inSection(heading));
      const offered = all.filter(inSection(heading));
      return {
        heading,
        candidates,
        offered,
        capacity: candidates.length + extraLines(candidates),
        total: offered.length + extraLines(offered),
        allocated: 0,
      };
    });
  const budget = Math.max(0, maxRows - Number(needsYou(rows).length > 0));
  let used = slots.filter((slot) => slot.offered.length > 0).length;
  while (true) {
    let changed = false;
    for (const slot of slots) {
      const next = slot.allocated + 1;
      if (next > slot.capacity) continue;
      const cost = next === slot.total ? 0 : 1;
      if (used + cost > budget) continue;
      slot.allocated = next;
      used += cost;
      changed = true;
    }
    if (!changed) break;
  }
  return slots.map(({ heading, candidates, offered, allocated }) => {
    const { entries, narrators, failureOverflow } = allocateWidgetRows(candidates, allocated);
    const hiddenFailures =
      sum(failureSlots(offered).map((slot) => slot.count)) - sum([...failureOverflow.values()]);
    return {
      heading,
      entries,
      narrators,
      failureOverflow,
      omittedRows: offered.length - entries.length + hiddenFailures,
      hiddenWorkflows: hiddenCount(offered, entries, ofType("workflow")),
      hiddenPhases: hiddenCount(offered, entries, ofType("phase")),
      hiddenSources:
        hiddenCount(
          offered,
          entries,
          (entry) => entry.type === "member" && !isPlannedEntry(entry),
        ) + hiddenFailures,
      hiddenPlanned: hiddenCount(offered, entries, isPlannedEntry),
    };
  });
}
