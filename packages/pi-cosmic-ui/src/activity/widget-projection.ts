import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ActivityRow } from "./model.ts";
import { needsYou, type ActivityTreeOptions } from "./tree.ts";
import { groupedActivityTree, type GroupedActivityRow } from "./grouped-tree.ts";

export interface WidgetOptions extends ActivityTreeOptions {
  readonly starting?: number;
  readonly now?: number;
  readonly theme?: Pick<Theme, "fg">;
}
export interface ActivityWidgetSection {
  readonly heading: GroupedActivityRow;
  readonly entries: readonly GroupedActivityRow[];
  /** Root workflows whose narrator line, their latest summary, fits beneath their row. */
  readonly narrators: ReadonlySet<string>;
  readonly omittedRows: number;
  /** Hidden work rows; workflow, phase and planned rows are counted separately. */
  readonly hiddenSources: number;
  readonly hiddenWorkflows: number;
  readonly hiddenPhases: number;
  readonly hiddenPlanned: number;
}

/** Declared work that has not started. */
export const isPlannedEntry = (entry: GroupedActivityRow): boolean =>
  entry.type === "member" && entry.row.planned === true;

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

// Publications replace the frozen rows array, and the checklist takes no presentation options,
// so one build serves every frame, height query and render until the next publication.
const checklists = new WeakMap<readonly ActivityRow[], readonly GroupedActivityRow[]>();
const checklist = (rows: readonly ActivityRow[]): readonly GroupedActivityRow[] => {
  const cached = checklists.get(rows);
  if (cached) return cached;
  const tree = groupedActivityTree(rows, { hideHistory: true, retainPhaseHistory: true });
  checklists.set(rows, tree);
  return tree;
};

/**
 * Grow for phase checklists, their planned work and narrator lines, but leave at least half the
 * terminal for the conversation/editor.
 */
export function activityWidgetHeight(rows: readonly ActivityRow[], terminalRows: number): number {
  const entries = checklist(rows);
  const structure =
    entries.filter(
      (entry) => entry.type === "workflow" || entry.type === "phase" || isPlannedEntry(entry),
    ).length + narratorCount(entries);
  return Math.max(1, Math.min(Math.floor(terminalRows / 2), Math.max(8, structure + 4)));
}

interface WidgetSlot {
  readonly id: string;
  readonly parentId: string | undefined;
}
const narratorSlot = (workflowId: string): string => `narrator:${workflowId}`;

/**
 * Reserve workflow roots, then ordered phase checklists, then narrator lines, then share member
 * detail across phases, and finally planned rows, which phase rows count when they don't fit.
 */
function allocateWidgetRows(
  rows: readonly GroupedActivityRow[],
  budget: number,
): Pick<ActivityWidgetSection, "entries" | "narrators"> {
  const roots = rows.filter((row) => row.type === "workflow" && row.depth === 1);
  if (!roots.length) return { entries: rows.slice(0, budget), narrators: new Set() };
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
    roots.map((root) => rows.filter((row) => row.type === "phase" && row.parentId === root.id)),
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
  for (const row of rows) {
    if (row.type === "phase") phaseById.set(row.id, row.id);
    else if (row.type !== "section" && row.parentId) {
      const phase = phaseById.get(row.parentId);
      if (!phase) continue;
      phaseById.set(row.id, phase);
      const byPhase = isPlannedEntry(row) ? plannedByPhase : membersByPhase;
      const members = byPhase.get(phase) ?? [];
      members.push(row);
      byPhase.set(phase, members);
    }
  }
  // Members without a known phase sit directly beneath their workflow root.
  const branches = [...phases, ...roots];
  share(branches.map((phase) => membersByPhase.get(phase.id) ?? []));
  share(branches.map((phase) => plannedByPhase.get(phase.id) ?? []));
  return {
    entries: rows.filter((row) => selected.has(row.id)),
    narrators: new Set(
      roots.filter((root) => selected.has(narratorSlot(root.id))).map((root) => root.id),
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
  const tree = all.flatMap((entry) => {
    const suppressed = entry.parentId !== undefined && hiddenDetail.has(entry.parentId);
    const collapsed = options.collapsed?.has(entry.id);
    if (suppressed || collapsed) hiddenDetail.add(entry.id);
    if (entry.type === "member" && suppressed) return [];
    return [
      (suppressed || collapsed) && entry.type !== "workflow"
        ? { ...entry, expanded: false }
        : entry,
    ];
  });
  const sections = tree.filter((entry) => entry.type === "section");
  const candidates = sections.map((section) =>
    tree.filter((entry) => entry.type !== "section" && entry.section === section.section),
  );
  const available = sections.map((section) =>
    all.filter((entry) => entry.type !== "section" && entry.section === section.section),
  );
  // Narrator lines take rows too; they belong to root workflows, which collapse never hides.
  const capacity = candidates.map((entries) => entries.length + narratorCount(entries));
  const total = available.map((entries) => entries.length + narratorCount(entries));
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
    const { entries, narrators } = allocateWidgetRows(candidates[index]!, allocated[index]!);
    const offered = available[index]!;
    return {
      heading,
      entries,
      narrators,
      omittedRows: offered.length - entries.length,
      hiddenWorkflows: hiddenCount(offered, entries, ofType("workflow")),
      hiddenPhases: hiddenCount(offered, entries, ofType("phase")),
      hiddenSources: hiddenCount(
        offered,
        entries,
        (entry) => entry.type === "member" && !isPlannedEntry(entry),
      ),
      hiddenPlanned: hiddenCount(offered, entries, isPlannedEntry),
    };
  });
}
