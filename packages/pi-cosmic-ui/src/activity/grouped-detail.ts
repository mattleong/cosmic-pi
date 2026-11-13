import type { Theme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { countLabel, formatRelativeAge } from "pi-cosmic-core/display";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import { joinInline } from "../manager/chrome.ts";
import type { ListDetailField } from "../manager/list-detail-shell.ts";
import { managerTone } from "../manager/style.ts";
import { activityActionKeys, isSectionAction } from "./action-keys.ts";
import { activityStatus } from "./attention.ts";
import type { GroupedActivityRow } from "./grouped-tree.ts";
import { summarizeGroup, workStateLabels, type GroupSummary } from "./group-summary.ts";
import { isFinished, type ActivityAction, type ActivityRow } from "./model.ts";
import type { ActivityDetail, ActivityDetailField } from "./protocol.ts";
import { activityAgentIdentity, activityElapsed, activityMark, activitySpan } from "./row-line.ts";

/**
 * Detail content before wrapping: verbatim text, agent-authored Markdown, or a muted line of
 * `·`-joined facts that wraps only between whole facts.
 */
export type ActivityDetailBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "fields"; readonly fields: ReadonlyArray<ListDetailField> }
  | { readonly kind: "facts"; readonly text: string }
  | { readonly kind: "markdown"; readonly text: string }
  /** One line, cut with `…` rather than wrapped, such as a child in a parent's rollup. */
  | { readonly kind: "line"; readonly text: string };

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
  /** The actions offered here: a row's own, or the section actions on a section heading. */
  readonly actions: ReadonlyArray<ActivityAction>;
  /** A member's direct children in tree order, for its rollup. */
  readonly children: readonly ActivityRow[];
  /** The selected member's owners from the root down, ending with the member itself. */
  readonly ownership: readonly ActivityRow[];
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
    { kind: "fields", fields: sectionFields(selected.summary) },
    ...actionBlocks(theme, options.actions, options.actionPage, true),
  ];
}

/** Children shown by name in a parent's rollup before the rest are counted. */
const ROLLUP_CHILDREN = 6;

/**
 * A parent's children at a glance: their states counted, then one line each with its glyph,
 * title, and latest summary, the rest counted on an `… n more` line.
 */
const childRollup = (options: GroupedDetailOptions): readonly ActivityDetailBlock[] => {
  const { children, theme } = options;
  if (!children.length) return [];
  const named = children.slice(0, ROLLUP_CHILDREN);
  const rest = children.slice(ROLLUP_CHILDREN);
  const childLine = (row: ActivityRow): ActivityDetailBlock => {
    const mark = activityMark(row, options.now);
    const summary = distinctSummary(row);
    return {
      kind: "line",
      text: `${theme.fg(mark.color, mark.glyph)} ${row.title}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
    };
  };
  return [
    spacer,
    { kind: "facts", text: joinInline(workStateLabels(summarizeGroup(children))) },
    ...Arr.map(named, childLine),
    ...(rest.length
      ? [
          {
            kind: "line" as const,
            text: theme.fg(
              "dim",
              joinInline([`… ${rest.length} more`, ...workStateLabels(summarizeGroup(rest))]),
            ),
          },
        ]
      : []),
  ];
};

const ageLabel = (row: ActivityRow, now: number | undefined): string => {
  if (now === undefined) return "";
  const ended = isFinished(row) && row.endedAt !== undefined;
  const at = ended ? row.endedAt : row.updatedAt;
  const age = at === undefined ? undefined : activitySpan(now, at);
  return age === undefined ? "" : `${ended ? "ended" : "updated"} ${formatRelativeAge(age)}`;
};

const statusLine = (options: GroupedDetailOptions, row: ActivityRow): string => {
  const status = activityStatus(row);
  return joinInline([
    row.kind === "agent" ? activityAgentIdentity(row) : undefined,
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

// An inspected item shows each section's fuller body where it has one.
const providerSections = (
  theme: DetailTheme,
  detail: ActivityDetail,
  inspected: boolean,
): readonly ActivityDetailBlock[] =>
  Arr.flatMap(detail.sections, (section, index) => {
    const body = (inspected ? section.expandedBody : undefined) ?? section.body;
    return [
      ...(index > 0 ? [spacer] : []),
      ...(section.title ? [text(theme.fg("muted", theme.bold(section.title)))] : []),
      section.format === "markdown" ? { kind: "markdown" as const, text: body } : text(body),
    ];
  });

const technicalFields = (
  row: ActivityRow,
  ownership: readonly ActivityRow[],
  provided: ReadonlyArray<ActivityDetailField>,
): ListDetailField[] => {
  const labels = new Set(Arr.map(provided, (field) => Str.toLowerCase(field.label)));
  // A field the provider already supplied is stated once, in its words.
  const shell = Arr.filter(
    shellTechnicalFields(row, ownership),
    (field) => !labels.has(Str.toLowerCase(field.label)),
  );
  return [...Arr.map(provided, (field) => ({ label: field.label, value: field.value })), ...shell];
};

const shellTechnicalFields = (
  row: ActivityRow,
  ownership: readonly ActivityRow[],
): ListDetailField[] => [
  {
    label: "Source",
    value: `${technicalIdentity(row.providerId)} / ${technicalIdentity(row.id)}`,
    tone: managerTone.identity,
  },
  { label: "Revision", value: `${technicalIdentity(row.revision)} · generation ${row.generation}` },
  ...(ownership.length > 1
    ? [
        {
          label: "Ownership",
          value: Arr.join(
            Arr.map(ownership, (item) => item.title),
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
  const { row } = entry;
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
    ? [...providerSections(theme, loaded, options.focused)]
    : options.loading
      ? [text(theme.fg("dim", "Loading output…"))]
      : [];
  return [
    text(heading(theme, Arr.join(entry.breadcrumbs, " › "), options.focused)),
    { kind: "facts", text: statusLine(options, row) },
    ...(summary ? [text(summary)] : []),
    ...childRollup(options),
    ...(body.length ? [spacer, ...body] : []),
    ...(row.omittedChildren
      ? [spacer, text(theme.fg("dim", `${row.omittedChildren}+ earlier finished items hidden`))]
      : []),
    ...(options.technical
      ? [
          spacer,
          text(theme.fg("muted", theme.bold("Technical"))),
          {
            kind: "fields" as const,
            fields: technicalFields(row, options.ownership, loaded?.technical ?? []),
          },
        ]
      : []),
    ...actionBlocks(theme, row.retained ? [] : options.actions, options.actionPage, false),
  ];
}

/**
 * The actions offered here, each with the one key that runs it. A row leaves out its section's
 * actions, which its section heading offers; their keys still work from the row.
 */
function actionBlocks(
  theme: DetailTheme,
  actions: ReadonlyArray<ActivityAction>,
  page: number,
  onHeading: boolean,
): readonly ActivityDetailBlock[] {
  const keys = activityActionKeys(actions, page);
  const shown = onHeading
    ? keys.shown
    : Arr.filter(keys.shown, ({ action }) => !isSectionAction(action));
  if (!shown.length) return [];
  return [
    spacer,
    ...Arr.map(
      shown,
      // Each action shows the one key that runs it, the same key the hint bar names.
      ({ key, action }) => text(`${theme.fg("dim", `[${key}]`)} ${action.label}`),
    ),
    ...(keys.pages > 1
      ? [text(theme.fg("dim", `[a] More actions · page ${keys.page + 1} of ${keys.pages}`))]
      : []),
  ];
}
