import {
  addGroupSummaries,
  emptyGroupSummary,
  phaseFinished,
  phaseProgress,
  phaseState,
  summarizeGroup,
  type GroupSummary,
  type PhaseState,
} from "./group-summary.ts";
export { groupSummaryLabels, phaseFinished } from "./group-summary.ts";
export type { GroupSummary, PhaseState } from "./group-summary.ts";
import { isFinished, resolveActivityOwnership, type ActivityRow } from "./model.ts";
import type { ActivityPhase } from "./protocol.ts";
import type { ActivityTreeOptions } from "./tree.ts";
import type { ActivitySection } from "./view-protocol.ts";

type Section = ActivitySection | "attention";
interface PresentationBase {
  readonly id: string;
  readonly title: string;
  readonly section: Section;
  readonly parentId: string | undefined;
  readonly depth: number;
  readonly continuations: readonly boolean[];
  readonly children: number;
  readonly expanded: boolean;
  readonly history: boolean;
  readonly summary: GroupSummary;
  readonly breadcrumbs: readonly string[];
}
export type GroupedActivityRow = PresentationBase &
  (
    | { readonly type: "section" }
    | {
        readonly type: "workflow";
        readonly row: ActivityRow;
        /** Source ancestry above the workflow row, root first. */
        readonly context: readonly ActivityRow[];
        readonly finishedPhases: number;
      }
    | {
        readonly type: "phase";
        readonly workflow: ActivityRow;
        readonly phase: ActivityPhase;
        readonly index: number;
        readonly state: PhaseState;
      }
    | {
        readonly type: "member";
        readonly row: ActivityRow;
        /** Source ancestry above the member row, root first. */
        readonly context: readonly ActivityRow[];
      }
  );
export const groupedActivitySource = (
  entry: GroupedActivityRow | undefined,
): ActivityRow | undefined => (entry && "row" in entry ? entry.row : undefined);

export const activitySectionId = (section: Section): string => `section:${section}`;
export const phaseRowId = (workflowKey: string, title: string): string =>
  `phase:${JSON.stringify([workflowKey, title])}`;

interface Node {
  readonly id: string;
  readonly title: string;
  readonly type: GroupedActivityRow["type"];
  readonly row?: ActivityRow;
  readonly workflow?: ActivityRow;
  readonly phase?: ActivityPhase;
  readonly index?: number;
  readonly children: Node[];
  section: Section;
  parentId: string | undefined;
  /** Every source in the branch; phase state and history read this. */
  total: GroupSummary;
  /** The displayed summary, which omits hidden history outside workflow subtrees. */
  summary: GroupSummary;
  history: boolean;
  state?: PhaseState;
}
const SECTIONS = [
  ["workflows", "Workflows"],
  ["subagents", "Subagents"],
  ["tasks", "Tasks"],
  ["attention", "Attention"],
] as const;
const rootSection = (row: ActivityRow): Section =>
  row.kind === "workflow"
    ? "workflows"
    : row.kind === "agent"
      ? "subagents"
      : row.kind === "command"
        ? "tasks"
        : "attention";
const blankNode = (id: string, title: string, type: Node["type"]): Node => ({
  id,
  title,
  type,
  children: [],
  section: "attention",
  parentId: undefined,
  total: emptyGroupSummary,
  summary: emptyGroupSummary,
  history: false,
});

/**
 * Pure display grouping over explicit ownership. Roots go to their kind's section; a workflow's
 * direct children nest under the phase they name, or directly under the workflow.
 */
export function groupedActivityTree(
  rows: readonly ActivityRow[],
  options: ActivityTreeOptions & { readonly retainPhaseHistory?: boolean } = {},
): readonly GroupedActivityRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const { parents } = resolveActivityOwnership(byKey);
  const contexts = new Map<string, readonly ActivityRow[]>();
  const context = (row: ActivityRow): readonly ActivityRow[] => {
    const cached = contexts.get(row.key);
    if (cached) return cached;
    const parent = parents.get(row.key);
    const owner = parent ? byKey.get(parent) : undefined;
    const value = owner ? [...context(owner), owner] : [];
    contexts.set(row.key, value);
    return value;
  };
  const sections: Node[] = SECTIONS.map(([section, title]) => ({
    ...blankNode(activitySectionId(section), title, "section"),
    section,
  }));
  const sectionNodes = new Map(sections.map((node) => [node.section, node]));
  // Every presentation node is addressable, so zoom can focus a section, workflow or phase.
  const nodes = new Map<string, Node>(sections.map((node) => [node.id, node]));
  const phases = new Map<string, Map<string, Node>>();
  for (const row of rows) {
    const node: Node = {
      ...blankNode(row.key, row.title, row.kind === "workflow" ? "workflow" : "member"),
      row,
    };
    nodes.set(row.key, node);
    if (row.kind !== "workflow") continue;
    const byTitle = new Map<string, Node>();
    row.phases?.forEach((phase, index) => {
      // Ingress rejects duplicate titles; tolerate them here without duplicate node IDs.
      if (byTitle.has(phase.title)) return;
      const branch: Node = {
        ...blankNode(phaseRowId(row.key, phase.title), phase.title, "phase"),
        workflow: row,
        phase,
        index,
        parentId: row.key,
      };
      byTitle.set(phase.title, branch);
      nodes.set(branch.id, branch);
      node.children.push(branch);
    });
    phases.set(row.key, byTitle);
  }
  for (const row of rows) {
    const node = nodes.get(row.key)!;
    const parent = parents.get(row.key);
    const owner = parent ? nodes.get(parent) : undefined;
    const phase =
      owner?.type === "workflow" && row.phase !== undefined
        ? phases.get(owner.id)?.get(row.phase)
        : undefined;
    const branch = phase ?? owner ?? sectionNodes.get(rootSection(row))!;
    node.parentId = branch.id;
    branch.children.push(node);
  }
  const complete = (node: Node, section: Section): void => {
    node.section = section;
    for (const child of node.children) complete(child, section);
    // A workflow row is a container: its own row shows its state, and summaries count its work.
    const row = node.row;
    const own = row && row.kind !== "workflow" ? summarizeGroup([row]) : emptyGroupSummary;
    node.total = node.children.reduce((sum, child) => addGroupSummaries(sum, child.total), own);
    // Workflows and phases keep finished work in view (failures stay visible as attention).
    node.summary =
      options.hideHistory && node.type !== "workflow" && node.type !== "phase"
        ? node.children
            .filter((child) => !child.history)
            .reduce((sum, child) => addGroupSummaries(sum, child.summary), own)
        : node.total;
    const settled =
      node.total.terminal === node.total.items &&
      node.total.awaited === 0 &&
      (!row || (isFinished(row) && !row.awaited));
    if (node.type === "phase") {
      const workflow = node.workflow!;
      const current = workflow.phases?.findIndex((phase) => phase.title === workflow.phase);
      node.state = phaseState(
        workflow,
        node.index!,
        current === undefined || current < 0 ? undefined : current,
        phaseProgress(node.phase!, node.total),
      );
      node.history = settled && phaseFinished(node.state);
    } else node.history = node.type !== "section" && settled;
  };
  for (const section of sections) complete(section, section.section);
  const pinned = (node: Node) => options.retainPhaseHistory === true && node.type === "phase";
  const visible = (node: Node) => !options.hideHistory || !node.history || pinned(node);
  const result: GroupedActivityRow[] = [];
  const visit = (node: Node, continuations: readonly boolean[], breadcrumbs: readonly string[]) => {
    if (!visible(node)) return;
    const children = node.children.filter(visible);
    if (
      node.type === "section" &&
      !children.length &&
      (options.hideHistory || node.section === "attention")
    )
      return;
    const expanded =
      children.length > 0 &&
      !options.collapsed?.has(node.id) &&
      (!node.history || options.expandedHistory?.has(node.id) === true || pinned(node));
    const base: PresentationBase = {
      id: node.id,
      title: node.title,
      section: node.section,
      parentId: node.parentId,
      depth: continuations.length,
      continuations,
      children: children.length,
      expanded,
      history: node.history,
      summary: node.summary,
      breadcrumbs: [...breadcrumbs, node.title],
    };
    result.push(groupedEntry(node, base, context));
    if (!expanded) return;
    // Phases keep their declared order; other work lists live rows before history.
    const ordered = [
      ...children.filter((child) => child.type === "phase"),
      ...children.filter((child) => child.type !== "phase" && !child.history),
      ...children.filter((child) => child.type !== "phase" && child.history),
    ];
    ordered.forEach((child, index) =>
      visit(child, [...continuations, index < ordered.length - 1], base.breadcrumbs),
    );
  };
  const focused = options.focus ? nodes.get(options.focus) : undefined;
  if (focused) visit(focused, [], []);
  else for (const section of sections) visit(section, [], []);
  return result;
}

const groupedEntry = (
  node: Node,
  base: PresentationBase,
  context: (row: ActivityRow) => readonly ActivityRow[],
): GroupedActivityRow => {
  if (node.type === "section") return { ...base, type: "section" };
  if (node.type === "phase")
    return {
      ...base,
      type: "phase",
      workflow: node.workflow!,
      phase: node.phase!,
      index: node.index!,
      state: node.state!,
    };
  const row = node.row!;
  if (node.type === "member") return { ...base, type: "member", row, context: context(row) };
  return {
    ...base,
    type: "workflow",
    row,
    context: context(row),
    finishedPhases: node.children.filter(
      (child) => child.type === "phase" && phaseFinished(child.state!),
    ).length,
  };
};

/** Presentation ancestry; source ownership remains separately available on `context`. */
export function groupedActivityPath(
  entries: readonly GroupedActivityRow[],
  id: string,
): readonly GroupedActivityRow[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: GroupedActivityRow[] = [];
  let entry = byId.get(id);
  while (entry) {
    path.unshift(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return path;
}
