import { activityPlanned } from "./attention.ts";
import {
  addGroupSummaries,
  countPhases,
  declaredPlanned,
  emptyGroupSummary,
  phaseFinished,
  phaseState,
  summarizeGroup,
  type GroupSummary,
  type PhaseCounts,
  type PhaseState,
} from "./group-summary.ts";
import { isFinished, resolveActivityOwnership, type ActivityRow } from "./model.ts";
import type { ActivityPhase } from "./protocol.ts";
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
        readonly context: readonly ActivityRow[];
        readonly phaseCounts: PhaseCounts;
        readonly unphased: Pick<GroupSummary, "planned" | "unrun">;
        readonly hiddenFailures: number;
      }
    | {
        readonly type: "phase";
        readonly workflow: ActivityRow;
        readonly phase: ActivityPhase;
        readonly index: number;
        readonly state: PhaseState;
        readonly members: readonly ActivityRow[];
        readonly hiddenFailures: number;
      }
    | {
        readonly type: "member";
        readonly row: ActivityRow;
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
  visible: GroupSummary;
  total: GroupSummary;
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
const ROOT_SECTIONS = {
  workflow: "workflows",
  agent: "subagents",
  command: "tasks",
  question: "attention",
} as const satisfies Record<ActivityRow["kind"], Section>;
const blankNode = (id: string, title: string, type: Node["type"]): Node => ({
  id,
  title,
  type,
  children: [],
  section: "attention",
  parentId: undefined,
  visible: emptyGroupSummary,
  total: emptyGroupSummary,
  summary: emptyGroupSummary,
  history: false,
});

interface GroupedActivityTreeOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly focus?: string;
  readonly hideHistory?: boolean;
  readonly liveFailures?: number;
}

export function groupedActivityTree(
  rows: readonly ActivityRow[],
  options: GroupedActivityTreeOptions = {},
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
    const branch = phase ?? owner ?? sectionNodes.get(ROOT_SECTIONS[row.kind])!;
    node.parentId = branch.id;
    branch.children.push(node);
  }
  const failures =
    options.hideHistory && options.liveFailures !== undefined
      ? liveFailures(nodes.values(), options.liveFailures)
      : { pinned: new Set<string>(), hidden: new Map<string, number>() };
  const complete = (node: Node, section: Section): void => {
    node.section = section;
    for (const child of node.children) complete(child, section);
    const row = node.row;
    const own = row && row.kind !== "workflow" ? summarizeGroup([row]) : emptyGroupSummary;
    node.visible = node.children.reduce((sum, child) => addGroupSummaries(sum, child.visible), own);
    node.total = withProducerCounts(
      node,
      node.children.reduce((sum, child) => addGroupSummaries(sum, child.total), own),
    );
    node.summary =
      options.hideHistory && node.type !== "workflow" && node.type !== "phase"
        ? node.children
            .filter((child) => !child.history)
            .reduce((sum, child) => addGroupSummaries(sum, child.summary), own)
        : node.total;
    const settled =
      node.visible.terminal === node.visible.items &&
      node.visible.awaited === 0 &&
      (!row || (isFinished(row) && !row.awaited));
    if (node.type === "phase") {
      const workflow = node.workflow!;
      const current = workflow.phases?.findIndex((phase) => phase.title === workflow.phase);
      node.state = phaseState(
        workflow,
        node.index!,
        current === undefined || current < 0 ? undefined : current,
        node.total,
      );
      node.history = settled && phaseFinished(node.state);
    } else node.history = node.type !== "section" && settled;
  };
  for (const section of sections) complete(section, section.section);
  const pinned = (node: Node) => node.type === "phase" || failures.pinned.has(node.id);
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
    result.push(groupedEntry(node, base, context, failures.hidden.get(node.id) ?? 0));
    if (!expanded) return;
    const rank = (child: Node) =>
      child.type === "phase"
        ? 0
        : 1 + 2 * Number(child.row?.planned === true) + Number(child.history);
    const ordered = [...children].sort((left, right) => rank(left) - rank(right));
    ordered.forEach((child, index) =>
      visit(child, [...continuations, index < ordered.length - 1], base.breadcrumbs),
    );
  };
  const focused = options.focus ? nodes.get(options.focus) : undefined;
  if (focused) visit(focused, [], []);
  else for (const section of sections) visit(section, [], []);
  return result;
}

const unphasedPlanned = (node: Node) => {
  const visible = summarizeGroup(
    node.children.flatMap((child) =>
      child.type === "member" && activityPlanned(child.row!) ? [child.row!] : [],
    ),
  );
  return { visible, declared: declaredPlanned(node.row!, node.row!.unphasedPlanned, visible) };
};

function liveFailures(nodes: Iterable<Node>, limit: number) {
  const pinned = new Set<string>();
  const hidden = new Map<string, number>();
  for (const node of nodes) {
    if (node.type !== "workflow" || isFinished(node.row!)) continue;
    const failed = [node, ...node.children.filter((child) => child.type === "phase")]
      .flatMap((branch) => branch.children)
      .filter((child) => child.type === "member" && child.row!.status === "failed")
      .sort((left, right) => (right.row!.endedAt ?? 0) - (left.row!.endedAt ?? 0));
    for (const child of failed.slice(0, limit)) pinned.add(child.id);
    for (const child of failed.slice(limit))
      hidden.set(child.parentId!, (hidden.get(child.parentId!) ?? 0) + 1);
  }
  return { pinned, hidden };
}

function withProducerCounts(node: Node, total: GroupSummary): GroupSummary {
  if (node.type === "phase") {
    const work = node.phase!.work;
    return {
      ...total,
      ...declaredPlanned(node.workflow!, node.phase!.planned, total),
      ...(work && {
        items: work.items,
        terminal: work.finished,
        stopped: work.stopped,
        skipped: work.skipped ?? 0,
      }),
      ...(work?.failed !== undefined && {
        attention: { ...total.attention, failed: work.failed },
      }),
    };
  }
  if (node.type !== "workflow") return total;
  const { visible, declared } = unphasedPlanned(node);
  return {
    ...total,
    planned: total.planned - visible.planned + declared.planned,
    unrun: total.unrun - visible.unrun + declared.unrun,
  };
}

const groupedEntry = (
  node: Node,
  base: PresentationBase,
  context: (row: ActivityRow) => readonly ActivityRow[],
  hiddenFailures: number,
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
      members: node.children.flatMap((child) => (child.type === "member" ? [child.row!] : [])),
      hiddenFailures,
    };
  const row = node.row!;
  if (node.type === "member") return { ...base, type: "member", row, context: context(row) };
  return {
    ...base,
    type: "workflow",
    row,
    context: context(row),
    phaseCounts: countPhases(
      node.children.flatMap((child) => (child.type === "phase" ? [child.state!] : [])),
    ),
    unphased: unphasedPlanned(node).declared,
    hiddenFailures,
  };
};

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
