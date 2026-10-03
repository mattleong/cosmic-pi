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
  readonly omittedRows: number;
  /** Hidden work rows; workflow and phase rows are counted separately. */
  readonly hiddenSources: number;
  readonly hiddenWorkflows: number;
  readonly hiddenPhases: number;
}

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

/** Grow for phase checklists, but leave at least half the terminal for the conversation/editor. */
export function activityWidgetHeight(rows: readonly ActivityRow[], terminalRows: number): number {
  const structure = checklist(rows).filter(
    (entry) => entry.type === "workflow" || entry.type === "phase",
  ).length;
  return Math.max(1, Math.min(Math.floor(terminalRows / 2), Math.max(8, structure + 4)));
}

/** Reserve workflow roots, then ordered phase checklists, then share member detail across phases. */
function allocateWidgetRows(
  rows: readonly GroupedActivityRow[],
  budget: number,
): readonly GroupedActivityRow[] {
  const roots = rows.filter((row) => row.type === "workflow" && row.depth === 1);
  if (!roots.length) return rows.slice(0, budget);
  const selected = new Set(roots.slice(0, budget).map((row) => row.id));
  const share = (branches: readonly (readonly GroupedActivityRow[])[]) => {
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
  const phases = rows.filter((row) => row.type === "phase" && selected.has(row.id));
  const phaseById = new Map<string, string>(roots.map((root) => [root.id, root.id]));
  const membersByPhase = new Map<string, GroupedActivityRow[]>();
  for (const row of rows) {
    if (row.type === "phase") phaseById.set(row.id, row.id);
    else if (row.type !== "section" && row.parentId) {
      const phase = phaseById.get(row.parentId);
      if (!phase) continue;
      phaseById.set(row.id, phase);
      const members = membersByPhase.get(phase) ?? [];
      members.push(row);
      membersByPhase.set(phase, members);
    }
  }
  // Members without a known phase sit directly beneath their workflow root.
  share([...phases, ...roots].map((phase) => membersByPhase.get(phase.id) ?? []));
  return rows.filter((row) => selected.has(row.id));
}

const hiddenCount = (
  available: readonly GroupedActivityRow[],
  shown: readonly GroupedActivityRow[],
  type: GroupedActivityRow["type"],
) =>
  available.filter((entry) => entry.type === type).length -
  shown.filter((entry) => entry.type === type).length;

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
  const allocated = sections.map(() => 0);
  const budget = Math.max(0, maxRows - Number(needsYou(rows).length > 0));
  let used = available.filter((entries) => entries.length > 0).length;
  while (true) {
    let changed = false;
    for (let index = 0; index < sections.length; index++) {
      const next = allocated[index]! + 1;
      if (next > candidates[index]!.length) continue;
      // The final row replaces its overflow notice rather than costing another line.
      const cost = next === available[index]!.length ? 0 : 1;
      if (used + cost > budget) continue;
      allocated[index] = next;
      used += cost;
      changed = true;
    }
    if (!changed) break;
  }
  return sections.map((heading, index) => {
    const entries = allocateWidgetRows(candidates[index]!, allocated[index]!);
    const offered = available[index]!;
    return {
      heading,
      entries,
      omittedRows: offered.length - entries.length,
      hiddenWorkflows: hiddenCount(offered, entries, "workflow"),
      hiddenPhases: hiddenCount(offered, entries, "phase"),
      hiddenSources: hiddenCount(offered, entries, "member"),
    };
  });
}
