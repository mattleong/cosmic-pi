import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel, formatElapsed, formatRelativeAge } from "pi-cosmic-core";
import {
  detailFieldRows,
  listDetailHeading,
  type ListDetailField,
} from "../manager/list-detail-shell.ts";
import { managerTone } from "../manager/style.ts";
import { ACTIVITY_ACTION_PAGE_SIZE, activityActionPages } from "./action-keys.ts";
import { activityStatus } from "./attention.ts";
import type { GroupedActivityRow, GroupSummary, PhaseCounts } from "./grouped-tree.ts";
import {
  phaseCountLabels,
  plannedLabels,
  workflowMemberSpan,
  workStateLabels,
} from "./group-summary.ts";
import type { ActivityRow } from "./model.ts";
import { activityElapsed, activityType } from "./row-line.ts";
import { activityOwnerLabel } from "./widget.ts";

/** Optional fields only appear with a value. */
const optionalField = (label: string, values: readonly string[]): ListDetailField[] =>
  values.length ? [{ label, value: values.join(" · ") }] : [];
/** Agents in each state, then the declarations and waits that are not work states. */
const memberFields = (summary: GroupSummary): ListDetailField[] => [
  {
    label: "Agents",
    value: [countLabel(summary.items, "agent"), ...workStateLabels(summary)].join(" · "),
  },
  ...optionalField("Progress", [
    ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
    ...plannedLabels(summary),
  ]),
];
/** Only a done phase is finished, matching the workflow's finished-phase count. */
const PHASE_STATES = {
  pending: "Not started",
  running: "Running",
  done: "Finished",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Skipped",
} as const;
/**
 * Done phases out of all phases, then failed, stopped and skipped ones. Rows leave failed phases
 * to their agents' failure notices; here the "Phases" label keeps the two counts apart.
 */
const phaseDetailLabels = (counts: PhaseCounts, total: number): string[] => {
  const [finished = "", ...settled] = phaseCountLabels(counts, total, "finished");
  return [finished, ...(counts.failed ? [`${counts.failed} failed`] : []), ...settled];
};

interface GroupedDetailOptions {
  readonly selected: GroupedActivityRow | undefined;
  readonly rows: readonly ActivityRow[];
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
    // A workflow's summary is its narrator line, such as its latest log line.
    const narrator = selected.row.summary?.trim();
    return sourceDetail(
      options,
      selected.row,
      selected.context,
      breadcrumb,
      [
        ...optionalField(
          "Phases",
          phases.length ? phaseDetailLabels(selected.phaseCounts, phases.length) : [],
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
      ...detailFieldRows(theme, [
        {
          label: "Sources",
          value: [countLabel(summary.items, "item"), ...workStateLabels(summary)].join(" · "),
        },
        ...optionalField("Progress", [
          ...(summary.awaited ? [`${summary.awaited} awaited`] : []),
          ...plannedLabels(summary),
        ]),
      ]),
      "Select a source to inspect its details and available actions.",
    ].join("\n");
  const span = workflowMemberSpan(selected.members, options.now);
  // The summary already carries the producer's counts, which include members and planned work
  // that are no longer, or never, shown.
  return [
    heading,
    breadcrumb,
    ...detailFieldRows(theme, [
      { label: "State", value: PHASE_STATES[selected.state] },
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
  const sourcePath = activityOwnerLabel(options.rows, row);
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
          { label: "Source", value: `${row.providerId} / ${row.id}`, tone: managerTone.identity },
          { label: "Revision", value: `${row.revision} · generation ${row.generation}` },
          ...(row.route ? [{ label: "Route", value: row.route, tone: managerTone.value }] : []),
          ...(context.length ? [{ label: "Ownership", value: sourcePath }] : []),
        ])
      : []),
    options.loaded ?? row.detail ?? "",
    row.omittedChildren ? `${row.omittedChildren}+ earlier finished items hidden` : "",
    ...actionLines(row, options.actionPage),
  ].join("\n");
}

/** The current page of a row's actions under their number keys, then how to turn the page. */
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
