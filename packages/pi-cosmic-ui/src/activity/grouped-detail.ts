import type { Theme } from "@earendil-works/pi-coding-agent";
import { countLabel, formatElapsed, formatRelativeAge } from "pi-cosmic-core";
import {
  detailFieldRows,
  listDetailHeading,
  type ListDetailField,
} from "../manager/list-detail-shell.ts";
import { managerTone } from "../manager/style.ts";
import { activityStatus } from "./attention.ts";
import { groupSummaryLabels, type GroupedActivityRow, type GroupSummary } from "./grouped-tree.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import { activityElapsed, activityOwnerLabel, activityType } from "./widget.ts";

/** Wall span across started members, not summed effort; queued members have not started. */
export function workflowMemberSpan(
  members: readonly ActivityRow[],
  now: number | undefined,
): number | undefined {
  let start = Infinity;
  let end = 0;
  for (const row of members) {
    if (row.startedAt === undefined) continue;
    const until = isFinished(row) ? row.endedAt : now;
    if (until === undefined) return undefined;
    start = Math.min(start, row.startedAt);
    end = Math.max(end, until);
  }
  return start === Infinity ? undefined : Math.max(0, end - start);
}

const memberFields = (summary: GroupSummary): ListDetailField[] => [
  {
    label: "Members",
    value: `${countLabel(summary.items, "member")} · ${summary.terminal} finished`,
  },
  { label: "Progress", value: groupSummaryLabels(summary).join(" · ") || "None" },
];
const PHASE_STATES = {
  pending: "Not started",
  running: "Running",
  done: "Finished",
  stopped: "Stopped",
  skipped: "Skipped",
} as const;

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
    return sourceDetail(options, selected.row, selected.context, breadcrumb, [
      ...(phases.length
        ? [{ label: "Phases", value: `${selected.finishedPhases}/${phases.length} finished` }]
        : []),
      ...(selected.row.phase ? [{ label: "Current phase", value: selected.row.phase }] : []),
      ...memberFields(selected.summary),
    ]);
  }
  const heading = listDetailHeading(theme, selected.title, options.focused, managerTone.identity);
  const summary = selected.summary;
  if (selected.type === "section")
    return [
      heading,
      breadcrumb,
      ...detailFieldRows(theme, [
        { label: "Sources", value: `${summary.items} items · ${summary.terminal} finished` },
        { label: "Progress", value: groupSummaryLabels(summary).join(" · ") || "None" },
      ]),
      "Select a source to inspect its details and available actions.",
    ].join("\n");
  const members = options.rows.filter((row) => {
    const phase = row.phase;
    return (
      phase === selected.phase.title &&
      row.parent?.providerId === selected.workflow.providerId &&
      row.parent.itemId === selected.workflow.id
    );
  });
  const span = workflowMemberSpan(members, options.now);
  // Producer counts include members that are no longer shown.
  const work = selected.phase.work;
  return [
    heading,
    breadcrumb,
    ...detailFieldRows(theme, [
      { label: "State", value: PHASE_STATES[selected.state] },
      ...memberFields(work ? { ...summary, items: work.items, terminal: work.finished } : summary),
      ...(span === undefined ? [] : [{ label: "Member span", value: formatElapsed(span) }]),
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
    row.summary ?? "",
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
    ...(row.retained ? [] : (row.actions ?? []))
      .slice(options.actionPage * 9, (options.actionPage + 1) * 9)
      .map((action, index) => `${index + 1} ${action.label}`),
    (row.actions?.length ?? 0) > 9 ? `a: more actions · page ${options.actionPage + 1}` : "",
  ].join("\n");
}
