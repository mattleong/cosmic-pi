import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  countLabel,
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
import { workStateLabels, type GroupSummary } from "./group-summary.ts";
import type { ActivityRow } from "./model.ts";
import { activityElapsed, activityType } from "./row-line.ts";

const optionalField = (label: string, values: readonly string[]): ListDetailField[] =>
  values.length ? [{ label, value: values.join(" · ") }] : [];
const technicalIdentity = (value: string): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(value));
const sectionFields = (summary: GroupSummary): ListDetailField[] => [
  {
    label: "Sources",
    value: [countLabel(summary.items, "item"), ...workStateLabels(summary)].join(" · "),
  },
  ...optionalField("Progress", summary.awaited ? [`${summary.awaited} awaited`] : []),
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
  return [
    listDetailHeading(theme, selected.title, options.focused, managerTone.identity),
    breadcrumb,
    ...detailFieldRows(theme, sectionFields(selected.summary)),
    "Select a source to inspect its details and available actions.",
  ].join("\n");
}

function sourceDetail(
  options: GroupedDetailOptions,
  row: ActivityRow,
  context: readonly ActivityRow[],
  breadcrumb: string,
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
    ]),
    options.now !== undefined && row.updatedAt !== undefined
      ? `Updated ${formatRelativeAge(options.now - row.updatedAt)}`
      : "",
    row.summary ?? "",
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
