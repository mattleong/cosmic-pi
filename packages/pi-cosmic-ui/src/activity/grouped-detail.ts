import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { countLabel, formatRelativeAge } from "pi-cosmic-core/display";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import { joinInline } from "../manager/chrome.ts";
import { detailFieldRows, type ListDetailField } from "../manager/list-detail-shell.ts";
import { managerTone } from "../manager/style.ts";
import { activityActionKeys } from "./action-keys.ts";
import { activityStatus } from "./attention.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import { workStateLabels, type GroupSummary } from "./group-summary.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityDetail, ActivityDetailField } from "./protocol.ts";
import { activityElapsed } from "./row-line.ts";

/** Detail content before wrapping: verbatim text, or agent-authored Markdown. */
export type ActivityDetailBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "markdown"; readonly text: string };

const text = (value: string): ActivityDetailBlock => ({ kind: "text", text: value });
const spacer = text("");

const technicalIdentity = (value: string): string =>
  sanitizeDiagnosticContent(sanitizeTerminalLine(value));

const sectionFields = (summary: GroupSummary): ListDetailField[] => [
  {
    label: "Status",
    value: joinInline([countLabel(summary.items, "item"), ...workStateLabels(summary)]),
  },
  ...(summary.awaited ? [{ label: "Progress", value: `${summary.awaited} awaited` }] : []),
];

type DetailTheme = Pick<Theme, "fg" | "bold">;

interface GroupedDetailOptions {
  readonly selected: GroupedActivityRow | undefined;
  readonly theme: DetailTheme;
  readonly focused: boolean;
  readonly now: number | undefined;
  /** The provider's lazily loaded detail for this item, when it has arrived. */
  readonly loaded: ActivityDetail | undefined;
  /** Whether a lazy load for this item is still outstanding. */
  readonly loading: boolean;
  readonly actionPage: number;
  readonly technical: boolean;
}

const heading = (theme: DetailTheme, value: string, focused: boolean): string =>
  focused
    ? theme.fg("accent", theme.bold(value))
    : theme.fg(managerTone.identity, theme.bold(value));

export function groupedDetail(options: GroupedDetailOptions): readonly ActivityDetailBlock[] {
  const { selected, theme } = options;
  if (!selected) return [text(theme.fg("dim", "Select an item"))];
  if (selected.type === "member") return sourceDetail(options, selected);
  return [
    text(heading(theme, Arr.join(selected.breadcrumbs, " › "), options.focused)),
    ...Arr.map(detailFieldRows(theme, sectionFields(selected.summary)), text),
    spacer,
    text(theme.fg("dim", "Select an item to see its output and actions.")),
  ];
}

const ageLabel = (row: ActivityRow, now: number | undefined): string => {
  if (now === undefined) return "";
  if (isFinished(row) && row.endedAt !== undefined)
    return `ended ${formatRelativeAge(now - row.endedAt)}`;
  return row.updatedAt === undefined ? "" : `updated ${formatRelativeAge(now - row.updatedAt)}`;
};

const statusLine = (options: GroupedDetailOptions, row: ActivityRow): string => {
  const status = activityStatus(row);
  return joinInline([
    row.kind === "agent" ? row.profile : undefined,
    status,
    activityElapsed(row, options.now),
    ageLabel(row, options.now),
  ]);
};

// A summary that only restates the status adds nothing beside it.
const distinctSummary = (row: ActivityRow): string | undefined => {
  const summary = row.summary === undefined ? "" : Str.trim(row.summary);
  return summary && Str.toLowerCase(summary) !== Str.toLowerCase(activityStatus(row))
    ? summary
    : undefined;
};

const providerSections = (
  theme: DetailTheme,
  detail: ActivityDetail,
): readonly ActivityDetailBlock[] =>
  Arr.flatMap(detail.sections, (section, index) => [
    ...(index > 0 ? [spacer] : []),
    ...(section.title ? [text(theme.fg("muted", theme.bold(section.title)))] : []),
    section.format === "markdown"
      ? { kind: "markdown" as const, text: section.body }
      : text(section.body),
  ]);

const technicalFields = (
  row: ActivityRow,
  context: readonly ActivityRow[],
  provided: ReadonlyArray<ActivityDetailField>,
): ListDetailField[] => {
  const labels = new Set(Arr.map(provided, (field) => Str.toLowerCase(field.label)));
  // A field the provider already supplied is stated once, in its words.
  const shell = Arr.filter(
    shellTechnicalFields(row, context),
    (field) => !labels.has(Str.toLowerCase(field.label)),
  );
  return [...Arr.map(provided, (field) => ({ label: field.label, value: field.value })), ...shell];
};

const shellTechnicalFields = (
  row: ActivityRow,
  context: readonly ActivityRow[],
): ListDetailField[] => [
  ...(row.route ? [{ label: "Route", value: row.route, tone: managerTone.value }] : []),
  {
    label: "Source",
    value: `${technicalIdentity(row.providerId)} / ${technicalIdentity(row.id)}`,
    tone: managerTone.identity,
  },
  { label: "Revision", value: `${technicalIdentity(row.revision)} · generation ${row.generation}` },
  ...(context.length
    ? [
        {
          label: "Ownership",
          value: Arr.join(
            Arr.map([...context, row], (item) => item.title),
            " › ",
          ),
        },
      ]
    : []),
];

function sourceDetail(
  options: GroupedDetailOptions,
  entry: Extract<GroupedActivityRow, { readonly type: "member" }>,
): readonly ActivityDetailBlock[] {
  const { theme } = options;
  const { row, context } = entry;
  const loaded = options.loaded ?? (row.detail ? { sections: [{ body: row.detail }] } : undefined);
  // A provider's lead section often opens with the same cause as the row summary, and live
  // progress is already in the loaded output.
  const live = row.status === "running" || row.status === "pending" || row.status === "stopping";
  const summary = Option.getOrUndefined(
    Option.filter(
      Option.fromUndefinedOr(distinctSummary(row)),
      (shown) =>
        !(live && options.loaded) &&
        !Arr.some(
          loaded?.sections ?? [],
          (section) => Str.trim(Str.split(section.body, "\n")[0] ?? "") === shown,
        ),
    ),
  );
  const body: ActivityDetailBlock[] = loaded
    ? [...providerSections(theme, loaded)]
    : options.loading
      ? [text(theme.fg("dim", "Loading output…"))]
      : [];
  return [
    text(heading(theme, Arr.join(entry.breadcrumbs, " › "), options.focused)),
    text(theme.fg("muted", statusLine(options, row))),
    ...(summary ? [text(summary)] : []),
    ...(body.length ? [spacer, ...body] : []),
    ...(row.omittedChildren
      ? [spacer, text(theme.fg("dim", `${row.omittedChildren}+ earlier finished items hidden`))]
      : []),
    ...(options.technical
      ? [
          spacer,
          text(theme.fg("muted", theme.bold("Technical"))),
          ...Arr.map(
            detailFieldRows(theme, technicalFields(row, context, loaded?.technical ?? [])),
            text,
          ),
        ]
      : []),
    ...actionBlocks(theme, row, options.actionPage),
  ];
}

function actionBlocks(
  theme: DetailTheme,
  row: ActivityRow,
  page: number,
): readonly ActivityDetailBlock[] {
  const keys = activityActionKeys(row.retained ? [] : row.actions, page);
  if (!keys.shown.length) return [];
  return [
    spacer,
    ...Arr.map(
      keys.shown,
      // Each action shows the one key that runs it, the same key the hint bar names.
      ({ key, action }) => text(`${theme.fg("dim", `[${key}]`)} ${action.label}`),
    ),
    ...(keys.pages > 1
      ? [text(theme.fg("dim", `[a] More actions · page ${keys.page + 1} of ${keys.pages}`))]
      : []),
  ];
}
