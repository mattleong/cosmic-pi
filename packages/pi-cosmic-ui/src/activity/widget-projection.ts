import type { Theme } from "@earendil-works/pi-coding-agent";
import { needsYou } from "./attention.ts";
import type { ActivityRow } from "./model.ts";
import { groupedActivityTree, type GroupedActivityRow } from "./grouped-tree.ts";

/** The widget shares the manager's collapse state; zoom and history stay manager-only. */
export interface WidgetOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly starting?: number;
  readonly now?: number;
  readonly theme?: Pick<Theme, "fg">;
}
export interface ActivityWidgetSection {
  readonly heading: GroupedActivityRow;
  readonly entries: readonly GroupedActivityRow[];
  /** Root workflows whose narrator line, their latest summary, fits beneath their row. */
  readonly narrators: ReadonlySet<string>;
  /**
   * Failed members past a live workflow's cap, counted per phase, or for the workflow's members
   * outside its phases, beneath the entry with this id: that branch's last failure shown, or the
   * branch row when none of its failures is.
   */
  readonly failureOverflow: ReadonlyMap<string, number>;
  readonly omittedRows: number;
  /**
   * Hidden work rows, including capped failures whose count line didn't fit; workflow, phase and
   * planned rows are counted separately.
   */
  readonly hiddenSources: number;
  readonly hiddenWorkflows: number;
  readonly hiddenPhases: number;
  readonly hiddenPlanned: number;
}

/** Failed members each live workflow keeps in the widget, most recent first. */
const LIVE_FAILURE_ROWS = 2;

/** Declared work that has not started. */
export const isPlannedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.planned === true;
/** A failed member; the widget keeps these only while their workflow is live. */
const isFailedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.status === "failed";

/**
 * A root workflow's narrator line: the producer's summary, such as its latest log line. Only
 * the widget shows it, beneath the workflow row; the manager shows it in the workflow detail.
 */
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

/**
 * A phase's failures past its live workflow's cap, or the workflow's own outside its phases, as
 * one line admitted with that branch row, so a count never reads as another phase's.
 */
const failureSlots = (
  entries: readonly GroupedActivityRow[],
): ReadonlyArray<WidgetSlot & { readonly parentId: string; readonly count: number }> =>
  entries.flatMap((entry) =>
    (entry.type === "workflow" || entry.type === "phase") && entry.hiddenFailures > 0
      ? [{ id: failureSlot(entry.id), parentId: entry.id, count: entry.hiddenFailures }]
      : [],
  );
const sum = (counts: readonly number[]) => counts.reduce((total, count) => total + count, 0);
/** Lines beside the grouped rows: narrators and hidden-failure counts. */
const extraLines = (entries: readonly GroupedActivityRow[]) =>
  narratorCount(entries) + failureSlots(entries).length;

// Publications replace the frozen rows array, and the checklist takes no presentation options,
// so one build serves every frame, height query and render until the next publication.
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

/**
 * Grow for phase checklists, their planned work, live failures and narrator lines, but leave at
 * least half the terminal for the conversation/editor.
 */
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

/**
 * Which phases a tight budget shows first: those whose work needs attention, then running ones,
 * then the rest. Shown phases still render in declaration order.
 */
const phasePriority = (row: GroupedActivityRow): number => {
  if (row.type !== "phase") return 2;
  const { user, parent, blocked, failed } = row.summary.attention;
  if (user + parent + blocked + failed > 0) return 0;
  return row.state === "running" ? 1 : 2;
};

/**
 * Reserve workflow roots, then phase checklists by {@link phasePriority}, then narrator lines,
 * then live failures and the count of those past the cap, then share member detail across
 * phases, and finally planned rows, which phase rows count when they don't fit.
 */
function allocateWidgetRows(
  rows: readonly GroupedActivityRow[],
  budget: number,
): Pick<ActivityWidgetSection, "entries" | "narrators" | "failureOverflow"> {
  const roots = rows.filter((row) => row.type === "workflow" && row.depth === 1);
  if (!roots.length)
    return { entries: rows.slice(0, budget), narrators: new Set(), failureOverflow: new Map() };
  const selected = new Set(roots.slice(0, budget).map((row) => row.id));
  const share = (branches: readonly (readonly WidgetSlot[])[]) => {
    const offsets = branches.map(() => 0);
    while (selected.size < budget) {
      let changed = false;
      for (let index = 0; index < branches.length && selected.size < budget; index++) {
        const row = branches[index]![offsets[index]!];
        if (!row) continue;
        // Presentation ancestors control admission, so no row is shown without its parent.
        if (row.parentId && !selected.has(row.parentId)) continue;
        selected.add(row.id);
        offsets[index]!++;
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
  // Members without a known phase sit directly beneath their workflow root.
  const branches = [...phases, ...roots];
  share(branches.map((phase) => failuresByPhase.get(phase.id) ?? []));
  const overflow = failureSlots(rows);
  share(overflow.map((slot) => [slot]));
  share(branches.map((phase) => membersByPhase.get(phase.id) ?? []));
  share(branches.map((phase) => plannedByPhase.get(phase.id) ?? []));
  const entries = rows.filter((row) => selected.has(row.id));
  // Each count sits beneath its branch's last failure shown, or beneath the branch row itself.
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

/** Share row space fairly; reserve overflow notices only for branches that do not fit. */
export function activityWidgetSections(
  rows: readonly ActivityRow[],
  maxRows = 8,
  options: WidgetOptions = {},
): readonly ActivityWidgetSection[] {
  // Collapse may reduce member detail, but never removes checklist structure.
  const all = checklist(rows);
  const hiddenDetail = new Set<string>();
  const tree = all.flatMap((entry): GroupedActivityRow[] => {
    const suppressed = entry.parentId !== undefined && hiddenDetail.has(entry.parentId);
    const collapsed = options.collapsed?.has(entry.id);
    if (!suppressed && !collapsed) return [entry];
    hiddenDetail.add(entry.id);
    if (entry.type === "member" && suppressed) return [];
    // Collapse folds capped failure counts into the omission notice with the rest of the detail.
    if (entry.type === "workflow") return [{ ...entry, hiddenFailures: 0 }];
    if (entry.type === "phase") return [{ ...entry, expanded: false, hiddenFailures: 0 }];
    return [{ ...entry, expanded: false }];
  });
  const sections = tree.filter((entry) => entry.type === "section");
  const candidates = sections.map((section) =>
    tree.filter((entry) => entry.type !== "section" && entry.section === section.section),
  );
  const available = sections.map((section) =>
    all.filter((entry) => entry.type !== "section" && entry.section === section.section),
  );
  // Narrator and failure-count lines take rows too; narrators belong to root workflows, which
  // collapse never hides.
  const capacity = candidates.map((entries) => entries.length + extraLines(entries));
  const total = available.map((entries) => entries.length + extraLines(entries));
  const allocated = sections.map(() => 0);
  const budget = Math.max(0, maxRows - Number(needsYou(rows).length > 0));
  let used = available.filter((entries) => entries.length > 0).length;
  while (true) {
    let changed = false;
    for (let index = 0; index < sections.length; index++) {
      const next = allocated[index]! + 1;
      if (next > capacity[index]!) continue;
      // The final row replaces its overflow notice rather than costing another line.
      const cost = next === total[index]! ? 0 : 1;
      if (used + cost > budget) continue;
      allocated[index] = next;
      used += cost;
      changed = true;
    }
    if (!changed) break;
  }
  return sections.map((heading, index) => {
    const { entries, narrators, failureOverflow } = allocateWidgetRows(
      candidates[index]!,
      allocated[index]!,
    );
    const offered = available[index]!;
    // Capped failures without a count line, cut by the budget or folded by collapse, join the
    // omission notice.
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
