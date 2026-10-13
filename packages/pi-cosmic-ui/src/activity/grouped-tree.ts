import {
  addGroupSummaries,
  emptyGroupSummary,
  summarizeGroup,
  type GroupSummary,
} from "./group-summary.ts";
import { isFinished, resolveActivityOwnership, type ActivityRow } from "./model.ts";
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
        readonly type: "member";
        readonly row: ActivityRow;
        readonly context: readonly ActivityRow[];
      }
  );
export const groupedActivitySource = (
  entry: GroupedActivityRow | undefined,
): ActivityRow | undefined => (entry && "row" in entry ? entry.row : undefined);

export const activitySectionId = (section: Section): string => `section:${section}`;

interface NodeState {
  readonly id: string;
  readonly title: string;
  readonly children: Node[];
  section: Section;
  parentId: string | undefined;
  visible: GroupSummary;
  total: GroupSummary;
  summary: GroupSummary;
  history: boolean;
}
type SectionNode = NodeState & { readonly type: "section" };
type RowNode = NodeState & { readonly type: "member"; readonly row: ActivityRow };
type Node = SectionNode | RowNode;

const ROOT_SECTIONS = {
  agent: "subagents",
  command: "tasks",
  question: "attention",
} as const satisfies Record<ActivityRow["kind"], Section>;
const blankNode = (id: string, title: string): NodeState => ({
  id,
  title,
  children: [],
  section: "attention",
  parentId: undefined,
  visible: emptyGroupSummary,
  total: emptyGroupSummary,
  summary: emptyGroupSummary,
  history: false,
});
const sectionNode = (section: Section, title: string): SectionNode => ({
  ...blankNode(activitySectionId(section), title),
  type: "section",
  section,
});
const makeSections = () => {
  const byName = {
    subagents: sectionNode("subagents", "Subagents"),
    tasks: sectionNode("tasks", "Tasks"),
    attention: sectionNode("attention", "Attention"),
  } satisfies Record<Section, SectionNode>;
  return { byName, ordered: [byName.subagents, byName.tasks, byName.attention] };
};

interface GroupedActivityTreeOptions {
  readonly collapsed?: ReadonlySet<string>;
  readonly expandedHistory?: ReadonlySet<string>;
  readonly focus?: string;
  readonly hideHistory?: boolean;
}

const rowContext = (
  byKey: ReadonlyMap<string, ActivityRow>,
  parents: ReadonlyMap<string, string>,
): ((row: ActivityRow) => readonly ActivityRow[]) => {
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
  return context;
};

function buildNodes(rows: readonly ActivityRow[], parents: ReadonlyMap<string, string>) {
  const { byName, ordered } = makeSections();
  const nodes = new Map<string, Node>(ordered.map((node) => [node.id, node]));
  for (const row of rows)
    nodes.set(row.key, { ...blankNode(row.key, row.title), type: "member", row });
  for (const row of rows) {
    const node = nodes.get(row.key);
    if (!node) continue;
    const parent = parents.get(row.key);
    const branch = (parent ? nodes.get(parent) : undefined) ?? byName[ROOT_SECTIONS[row.kind]];
    node.parentId = branch.id;
    branch.children.push(node);
  }
  return { sections: ordered, nodes };
}

const sumSummaries = (
  nodes: readonly Node[],
  pick: (node: Node) => GroupSummary,
  own: GroupSummary,
): GroupSummary => nodes.reduce((sum, child) => addGroupSummaries(sum, pick(child)), own);

function completeNode(node: Node, section: Section, hideHistory: boolean): void {
  node.section = section;
  for (const child of node.children) completeNode(child, section, hideHistory);
  const row = node.type === "member" ? node.row : undefined;
  const own = row ? summarizeGroup([row]) : emptyGroupSummary;
  node.visible = sumSummaries(node.children, (child) => child.visible, own);
  node.total = sumSummaries(node.children, (child) => child.total, own);
  node.summary = hideHistory
    ? sumSummaries(
        node.children.filter((child) => !child.history),
        (child) => child.summary,
        own,
      )
    : node.total;
  node.history =
    row !== undefined &&
    node.visible.terminal === node.visible.items &&
    node.visible.awaited === 0 &&
    isFinished(row) &&
    !row.awaited;
}

export function groupedActivityTree(
  rows: readonly ActivityRow[],
  options: GroupedActivityTreeOptions = {},
): readonly GroupedActivityRow[] {
  const byKey = new Map(rows.map((row) => [row.key, row]));
  const { parents } = resolveActivityOwnership(byKey);
  const context = rowContext(byKey, parents);
  const { sections, nodes } = buildNodes(rows, parents);
  for (const section of sections)
    completeNode(section, section.section, options.hideHistory === true);
  const visible = (node: Node) => !options.hideHistory || !node.history;
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
      (!node.history || options.expandedHistory?.has(node.id) === true);
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
    result.push(
      node.type === "section"
        ? { ...base, type: "section" }
        : { ...base, type: "member", row: node.row, context: context(node.row) },
    );
    if (!expanded) return;
    const ordered = children.toSorted(
      (left, right) => Number(left.history) - Number(right.history),
    );
    ordered.forEach((child, index) =>
      visit(child, [...continuations, index < ordered.length - 1], base.breadcrumbs),
    );
  };
  const focused = options.focus ? nodes.get(options.focus) : undefined;
  if (focused) visit(focused, [], []);
  else for (const section of sections) visit(section, [], []);
  return result;
}

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
