import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  countLabel,
  formatElapsed,
  formatRelativeAge,
  sanitizeDiagnosticContent,
  sanitizeTerminalLine,
} from "pi-cosmic-core";
import {
  detailFieldRows,
  listDetailHeading,
  type ListDetailField,
} from "../manager/list-detail-shell.ts";
import { managerTone } from "../manager/style.ts";
import { ACTIVITY_ACTION_PAGE_SIZE, activityActionPages } from "./action-keys.ts";
import { activityStatus } from "./attention.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import {
  phaseCountLabels,
  plannedLabels,
  workflowMemberSpan,
  workStateLabels,
  type GroupSummary,
} from "./group-summary.ts";
import type { ActivityRow } from "./model.ts";
import { activityElapsed, activityType } from "./row-line.ts";
import { phaseLabels } from "./workflow-row.ts";

const optionalField = (label: string, values: readonly string[]): ListDetailField[] =>
  values.length ? [{ label, value: values.join(" · ") }] : [];
const technicalIdentity = (value: string): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(value));
const memberFields = (
  summary: GroupSummary,
  label = "Agents",
  noun = "agent",
): ListDetailField[] => [
  { label, value: [countLabel(summary.items, noun), ...workStateLabels(summary)].join(" · ") },
  ...optionalField("Progress", [
    ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
    ...plannedLabels(summary),
  ]),
];

interface GroupedDetailOptions {
  readonly selected: GroupedActivityRow | undefined;
  readonly theme: Pick<Theme, "fg" | "bold">;
  readonly focused: boolean;
  readonly now: number | undefined;
  readonly loaded: string | undefined;
  readonly actionPage: number;
  readonly technical: boolean;
}
export function groupedDetail(options: GroupedDetailOptions): string {
  const { selected, theme } = options;
  if (!selected) return "Select an item";
  const breadcrumb = selected.breadcrumbs.join(" › ");
  if (selected.type === "member")
    return sourceDetail(options, selected.row, selected.context, breadcrumb);
  if (selected.type === "workflow") {
    const phases = selected.row.phases ?? [];
    const narrator = selected.row.summary?.trim();
    return sourceDetail(
      options,
      selected.row,
      selected.context,
      breadcrumb,
      [
        ...optionalField(
          "Phases",
          phases.length
            ? phaseCountLabels(selected.phaseCounts, phases.length, "finished", true)
            : [],
        ),
        ...(selected.row.phase ? [{ label: "Current phase", value: selected.row.phase }] : []),
        ...memberFields(selected.summary),
        ...(narrator ? [{ label: "Latest", value: narrator }] : []),
      ],
      false,
    );
  }
  const heading = listDetailHeading(theme, selected.title, options.focused, managerTone.identity);
  const summary = selected.summary;
  if (selected.type === "section")
    return [
      heading,
      breadcrumb,
      ...detailFieldRows(theme, memberFields(summary, "Sources", "item")),
      "Select a source to inspect its details and available actions.",
    ].join("\n");
  const span = workflowMemberSpan(selected.members, options.now);
  return [
    heading,
    breadcrumb,
    ...detailFieldRows(theme, [
      { label: "State", value: capitalized(phaseLabels[selected.state]) },
      ...memberFields(summary),
      ...optionalField("Elapsed", span === undefined ? [] : [formatElapsed(span)]),
    ]),
    selected.phase.detail ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

function sourceDetail(
  options: GroupedDetailOptions,
  row: ActivityRow,
  context: readonly ActivityRow[],
  breadcrumb: string,
  fields: readonly ListDetailField[] = [],
  showSummary = true,
): string {
  const { theme } = options;
  const sourcePath = [...context, row].map((item) => item.title).join(" › ");
  return [
    listDetailHeading(theme, sourcePath, options.focused, managerTone.identity),
    breadcrumb,
    ...detailFieldRows(theme, [
      {
        label: "Status",
        value: [
          activityType(row),
          row.kind === "agent" ? row.profile : undefined,
          activityStatus(row),
          activityElapsed(row, options.now),
        ]
          .filter(Boolean)
          .join(" · "),
      },
      ...fields,
    ]),
    options.now !== undefined && row.updatedAt !== undefined
      ? `Updated ${formatRelativeAge(options.now - row.updatedAt)}`
      : "",
    showSummary ? (row.summary ?? "") : "",
    ...(options.technical
      ? detailFieldRows(theme, [
          {
            label: "Source",
            value: `${technicalIdentity(row.providerId)} / ${technicalIdentity(row.id)}`,
            tone: managerTone.identity,
          },
          {
            label: "Revision",
            value: `${technicalIdentity(row.revision)} · generation ${row.generation}`,
          },
          ...(row.route ? [{ label: "Route", value: row.route, tone: managerTone.value }] : []),
          ...(context.length ? [{ label: "Ownership", value: sourcePath }] : []),
        ])
      : []),
    options.loaded ?? row.detail ?? "",
    row.omittedChildren ? `${row.omittedChildren}+ earlier finished items hidden` : "",
    ...actionLines(row, options.actionPage),
  ].join("\n");
}

const capitalized = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function actionLines(row: ActivityRow, page: number): string[] {
  const actions = row.retained ? [] : (row.actions ?? []);
  const pages = activityActionPages(actions);
  return [
    ...actions
      .slice(page * ACTIVITY_ACTION_PAGE_SIZE, (page + 1) * ACTIVITY_ACTION_PAGE_SIZE)
      .map((action, index) => `${index + 1} ${action.label}`),
    ...(pages > 1 ? [`a More actions · page ${page + 1} of ${pages}`] : []),
  ];
}
