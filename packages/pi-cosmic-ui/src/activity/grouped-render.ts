import { countLabel } from "pi-cosmic-core/display";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { LIST_CURSOR, focusedField } from "../manager/style.ts";
import {
  clipToWidth,
  joinInline,
  managerNoticeColor,
  managerNoticeGlyph,
  wrapFacts,
  type ManagerStatusColor,
} from "../manager/chrome.ts";
import {
  configuredKeyLabels,
  exitKeyHint,
  exitKeyVerb,
  fittedBorderKeyHint,
  framedKeyHintBar,
  framedKeyHints,
  joinKeyHints,
  keyHint,
  keyHintBarParts,
  keyHintRows,
  moveKeyHint,
  type FramedKeyHints,
} from "../manager/key-labels.ts";
import {
  detailWindowPositionLabel,
  listWindowPositionLabel,
  stackedListHeight,
  wideListDetailGeometry,
  type DetailWindowPosition,
} from "../manager/list-detail.ts";
import {
  FRAME_GUTTER,
  framedBodyWithHints,
  framedBodyWithPrompt,
  framedFill,
  framedGutter,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  detailFieldRows,
  listDetailFrame,
  paneHeadingText,
  type ListDetailShell,
} from "../manager/list-detail-shell.ts";
import { activityActionHints, activityShortcuts, type ActivityActionHints } from "./action-keys.ts";
import {
  activityAttentionParts,
  activityCanFollow,
  needsYou,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { activityStartupGlyph, activityOwnerLabel } from "./widget.ts";
import { groupedMemberLines } from "./row-line.ts";
import { groupedActivitySource, type GroupedActivityRow } from "./grouped-tree.ts";
import { groupSummaryLabels, summarizeGroup } from "./group-summary.ts";
import { groupedDetail, type ActivityDetailBlock } from "./grouped-detail.ts";
import type { ActivityComponentOptions } from "./component.ts";
import type { ActivityDetailRequest } from "./service.ts";
import { activityPath, type ActivityAction, type ActivityRow } from "./model.ts";
import type { ActivityDetail } from "./protocol.ts";
import { markdownTheme } from "../tool/presentation.ts";

const CURSOR = `${LIST_CURSOR} `;
// The list needs room for a tree, a title, and a whole `provider/model` beside the detail pane.
const ACTIVITY_LIST_MIN_WIDTH = 46;
const ACTIVITY_LIST_SHARE = 0.45;
const NO_CURSOR = "  ";

function rowLines(
  entry: GroupedActivityRow,
  width: number,
  options: ActivityComponentOptions,
  focused: boolean,
): readonly string[] {
  const theme = options.theme;
  const focusedStyle = focused ? (text: string) => focusedField(theme, text) : undefined;
  const paint = { now: options.now?.(), theme };
  if (entry.type === "member")
    return groupedMemberLines(entry, width, paint, "manager", focusedStyle);
  const fold = entry.children ? (entry.expanded ? "▾ " : "▸ ") : "  ";
  const fits = (summary: string) =>
    visibleWidth(`${fold}${entry.title}${summary ? ` · ${summary}` : ""}`) <= width;
  const tiers = Arr.map(["full", "live", "attention", "urgent"] as const, (detail) =>
    joinInline(groupSummaryLabels(entry.summary, detail)),
  );
  const summary = Option.getOrElse(Arr.findFirst(tiers, fits), () => tiers.at(-1) ?? "");
  return [
    clipToWidth(
      `${theme.fg("dim", fold)}${focused ? focusedField(theme, entry.title) : theme.fg("accent", entry.title)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
      width,
      "…",
    ),
  ];
}

interface ActivityKeys {
  readonly confirm: string;
  /** The primary cancel key; any other configured cancel keys are aliases for expanded help. */
  readonly cancel: string;
  readonly cancelAliases: ReadonlyArray<string>;
  readonly move: string;
}

// A long action label gives way to `Confirm` so the decision keys always fit the border.
function confirmationFooter(
  confirmation: { readonly label: string; readonly key: string | undefined },
  { confirm, cancel }: ActivityKeys,
  inner: number,
): string {
  const keys = confirmation.key ? `${confirmation.key}/${confirm}` : confirm;
  const decline = exitKeyHint("decision", [], cancel);
  return fittedBorderKeyHint(
    joinKeyHints([keyHint(keys, confirmation.label), decline]),
    joinKeyHints([keyHint(keys, "Confirm"), decline]),
    inner,
  );
}

const JUMP_TO_INPUT = keyHint("w", "Next input");

type ActivityFilterState = "none" | "typing" | "applied";

interface ActivityBarView {
  /** Whether the selected source's detail is followed now. */
  readonly follow: boolean;
  /** Whether the selected source can still produce output to follow. */
  readonly canFollow: boolean;
  /** A source is selected whose details can be refreshed and inspected. */
  readonly selectable: boolean;
  /** What Enter does in the list: inspect a source, or fold or unfold a section. */
  readonly enter: "Inspect" | "Fold" | "Unfold" | undefined;
  /** Something needs the user's input, so `w` leads to it from the default bar. */
  readonly waiting: boolean;
  readonly filter: ActivityFilterState;
}

/** The Activity bar; an empty list offers nothing to move through or inspect. */
const navigationHints = (
  listFocused: boolean,
  empty: boolean,
  actions: ActivityActionHints,
  view: ActivityBarView,
  keys: ActivityKeys,
  expanded: boolean,
  inner: number,
): FramedKeyHints => {
  const clear = keyHint(keys.cancel, "Clear");
  if (listFocused && view.filter === "typing")
    return framedKeyHints(
      ["Type to filter", !empty && moveKeyHint(keys.move), keyHint(keys.confirm, "Done")],
      [clear],
      inner,
    );
  const follow =
    view.selectable && (view.canFollow || view.follow)
      ? keyHint("f", view.follow ? "Unfollow" : "Follow")
      : undefined;
  const technical = view.selectable ? keyHint("t", "Technical") : undefined;
  const refresh = view.selectable ? keyHint("r", "Refresh") : undefined;
  const jump = view.waiting ? JUMP_TO_INPUT : undefined;
  const paging = [
    keyHint("C-u/C-d", "Half-page"),
    keyHint("PgUp/PgDn", "Page"),
    keyHint("gg/G", "Ends"),
  ];
  if (!listFocused)
    return framedKeyHintBar(
      {
        hints: [keyHint(keys.move, "Scroll"), actions.primary, follow, technical, jump],
        more: [
          keyHint("j/k", "Scroll"),
          ...paging,
          keyHint("z", "Zoom"),
          refresh,
          ...actions.section,
          keyHint("q", exitKeyVerb("top")),
        ],
        exit: "nested",
        exitKey: keys.cancel,
        exitAliases: [...keys.cancelAliases, "h"],
      },
      expanded,
      inner,
    );
  const filter = (!empty || view.filter === "applied") && keyHint("/", "Filter");
  const hints = empty
    ? [filter]
    : [
        moveKeyHint(keys.move),
        view.enter && keyHint(keys.confirm, view.enter),
        actions.primary,
        follow,
        filter,
        jump,
      ];
  const more = empty
    ? []
    : [
        keyHint("j/k", "Move"),
        keyHint("h/l", "Fold"),
        ...paging,
        technical,
        keyHint("z", "Zoom"),
        refresh,
        ...actions.section,
      ];
  // An applied filter is cleared before the next Esc closes.
  if (view.filter === "applied") {
    const parts = keyHintBarParts({ hints, more: [...more, keyHint("q", "Close")] }, expanded);
    return framedKeyHints(parts.hints, [clear, ...parts.tail], inner);
  }
  return framedKeyHintBar(
    {
      hints,
      more,
      exit: "top",
      exitKey: keys.cancel,
      exitAliases: [...keys.cancelAliases, "q"],
    },
    expanded,
    inner,
  );
};

interface GroupedActivityState {
  readonly shell: ListDetailShell;
  readonly entries: readonly GroupedActivityRow[];
  /** Items the tree presents, including those inside folded branches. */
  readonly itemCount: number;
  readonly selected: GroupedActivityRow | undefined;
  readonly alternateHelp: boolean;
  readonly actionPage: number;
  readonly loaded:
    | { readonly request: ActivityDetailRequest; readonly detail: ActivityDetail }
    | undefined;
  readonly loading: boolean;
  readonly confirmation:
    | { readonly text: string; readonly label: string; readonly key: string | undefined }
    | undefined;
  readonly follow: boolean;
  readonly technical: boolean;
  readonly detailPosition: DetailWindowPosition;
  /** The actions offered for the selection: a row's own, or its section's on a heading. */
  readonly actions: ReadonlyArray<ActivityAction>;
  /** The selected member's direct children, for its rollup. */
  readonly children: readonly ActivityRow[];
  readonly filter: ActivityFilterView | undefined;
}

/** A typed filter: its query, whether it still takes the keys, and how many items match. */
export interface ActivityFilterView {
  readonly query: string;
  readonly typing: boolean;
  readonly matches: number;
  /** The query as an input line `width` columns wide, shown while typing. */
  readonly input: (width: number) => string;
}

interface GroupedBodyContext {
  readonly options: ActivityComponentOptions;
  readonly state: GroupedActivityState;
  readonly rows: readonly ActivityRow[];
  readonly urgent: readonly ActivityRow[];
  readonly row: ActivityRow | undefined;
  readonly listFocused: boolean;
  /** False while a confirmation holds the keys; the panes stay on screen without focus. */
  readonly interactive: boolean;
}

function needsYouLine(
  { options, rows, urgent }: GroupedBodyContext,
  first: ActivityRow,
  width: number,
): string {
  const more = urgent.length > 1 ? ` +${urgent.length - 1}` : "";
  const jump = ` · ${JUMP_TO_INPUT}`;
  const prefix = `${managerNoticeGlyph("attention")} Needs your input: `;
  const owner = activityOwnerLabel(
    rows,
    first,
    Math.max(0, width - visibleWidth(prefix) - visibleWidth(more) - visibleWidth(jump)),
  );
  return options.theme.fg(
    managerNoticeColor("attention"),
    clipToWidth(`${prefix}${owner}${more}${jump}`, width, "…"),
  );
}

const paneHeading = (
  theme: ActivityComponentOptions["theme"],
  text: string,
  focused: boolean,
): string => (focused ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text));

const EMPTY_ACTIVITY = "Subagents, tasks, and questions appear here.";

const emptyText = (filter: ActivityFilterView | undefined): string =>
  filter?.query ? `No items match "${filter.query}".` : EMPTY_ACTIVITY;

/** The list heading's title, which says when a filter applies and how many items match it. */
const listTitle = (filter: ActivityFilterView | undefined): string =>
  filter?.query
    ? joinInline([
        "Items",
        `${countLabel(filter.matches, "match", "matches")}${filter.typing ? "" : ` for "${filter.query}"`}`,
      ])
    : "Items";

// Text keeps a one-column gutter on each side, off the frame and the pane divider.
const listTextWidth = (listWidth: number): number => Math.max(0, listWidth - 2 * FRAME_GUTTER);
const listRowWidth = (listWidth: number): number =>
  Math.max(0, listTextWidth(listWidth) - CURSOR.length);

/**
 * Lines the list would draw at `listWidth`, heading included, counting no further than `limit`:
 * a row that wraps its identity takes two.
 */
function activityListLines(context: GroupedBodyContext, listWidth: number, limit: number): number {
  const { options, state } = context;
  const typing = Number(state.filter?.typing === true);
  // An empty list still points at waiting work, which its filter or zoom hides.
  if (!state.entries.length)
    return (
      1 +
      typing +
      Number(context.urgent.length > 0) +
      wrapTextWithAnsi(emptyText(state.filter), Math.max(1, listTextWidth(listWidth))).length
    );
  let lines = 1 + typing;
  for (const entry of state.entries) {
    if (lines > limit) break;
    lines += rowLines(entry, listRowWidth(listWidth), options, false).length;
  }
  return lines;
}

function activityList(
  context: GroupedBodyContext,
  listHeight: number,
  listWidth: number,
): string[] {
  const { options, state, urgent, interactive } = context;
  const listFocused = context.listFocused && interactive;
  const { shell, entries, selected } = state;
  const showHeading = listHeight > 1;
  const textWidth = listTextWidth(listWidth);
  const rowWidth = listRowWidth(listWidth);
  // While typing, the query takes a line under the heading.
  const input = state.filter?.typing && listHeight > 2 ? state.filter.input(textWidth) : undefined;
  const rows = listHeight - Number(showHeading) - Number(input !== undefined);
  // A row that wraps its identity takes two lines. Only rows near the selection can be on
  // screen, so only those are drawn.
  const reach = Math.max(1, rows);
  const nearFirst = Math.max(0, shell.state.selected - reach);
  const nearEnd = Math.min(entries.length, shell.state.selected + reach + 1);
  const drawn = new Map(
    Arr.map(entries.slice(nearFirst, nearEnd), (entry) => {
      const isSelected = entry.id === selected?.id;
      const lines = rowLines(entry, rowWidth, options, isSelected && listFocused);
      const cursor = isSelected ? options.theme.fg("accent", CURSOR) : NO_CURSOR;
      return [
        entry.id,
        Arr.map(lines, (line, index) => `${index === 0 ? cursor : NO_CURSOR}${line}`),
      ] as const;
    }),
  );
  const heights = Arr.map(entries, (entry) => drawn.get(entry.id)?.length ?? 1);
  const listed = (start: number, end: number) =>
    new Set(
      Arr.flatMap(entries.slice(start, end), (entry) =>
        entry.type === "member" ? [entry.row.key] : [],
      ),
    );
  // The banner points at waiting work the list doesn't show; a visible row speaks for itself.
  const full = shell.visibleWindow(entries.length, rows, heights);
  const shown = listed(full.start, full.end);
  const unseen = Arr.filter(urgent, (row) => !shown.has(row.key));
  const first = listHeight > 2 ? unseen[0] : undefined;
  const window = first ? shell.visibleWindow(entries.length, rows - 1, heights) : full;
  const list = Arr.flatMap(
    entries.slice(window.start, window.end),
    (entry) => drawn.get(entry.id) ?? [],
  );
  if (!entries.length)
    list.push(
      ...Arr.map(wrapTextWithAnsi(emptyText(state.filter), Math.max(1, textWidth)), (line) =>
        options.theme.fg(state.filter?.query ? "warning" : "dim", line),
      ),
    );
  if (first) list.unshift(needsYouLine({ ...context, urgent: unseen }, first, textWidth));
  if (input !== undefined) list.unshift(input);
  if (showHeading)
    list.unshift(
      paneHeading(
        options.theme,
        paneHeadingText(
          listTitle(state.filter),
          listWindowPositionLabel(window, entries.length),
          textWidth,
        ),
        listFocused,
      ),
    );
  const body = framedGutter(list.slice(0, listHeight), listWidth);
  while (body.length < listHeight) body.push("");
  return body;
}

type BodyTheme = ActivityComponentOptions["theme"];

const HANGING_INDENT = "  ";

// Wrapped continuation lines hang under their first line so long output stays scannable.
const wrapVerbatim = (text: string, width: number): string[] =>
  Arr.flatMap(Str.split(text, "\n"), (line) => {
    const hanging = width > 8 ? HANGING_INDENT : "";
    const wrapped = wrapTextWithAnsi(line, Math.max(1, width - hanging.length));
    if (wrapped.length <= 1) return wrapTextWithAnsi(line, width);
    return Arr.map(wrapped, (part, index) => (index === 0 ? part : `${hanging}${part}`));
  });

const renderBlocks = (
  blocks: readonly ActivityDetailBlock[],
  width: number,
  theme: BodyTheme,
): string[] =>
  Arr.flatMap(blocks, (block) =>
    Match.value(block).pipe(
      Match.discriminatorsExhaustive("kind")({
        markdown: ({ text }) => new Markdown(text, 0, 0, markdownTheme(theme)).render(width),
        facts: ({ text }) => Arr.map(wrapFacts(text, width), (line) => theme.fg("muted", line)),
        fields: ({ fields }) => [...detailFieldRows(theme, fields, width)],
        text: ({ text }) => wrapVerbatim(text, width),
        line: ({ text }) => [clipToWidth(text, width, "…")],
      }),
    ),
  );

const blockKey = (block: ActivityDetailBlock): string =>
  block.kind === "fields"
    ? `fields\u0000${Arr.join(
        Arr.map(
          block.fields,
          (field) => `${field.label}\u0002${field.value}\u0002${field.tone ?? ""}`,
        ),
        "\u0003",
      )}`
    : `${block.kind}\u0000${block.text}`;

interface WrappedDetail {
  readonly key: string;
  readonly width: number;
  readonly lines: readonly string[];
}

// Details hold up to 16 KB and the manager re-renders on every key and spinner frame; keyed by
// each manager's shell so the wrap lives only as long as its view.
const wrappedDetails = new WeakMap<ListDetailShell, WrappedDetail>();
const wrappedDetail = (
  shell: ListDetailShell,
  blocks: readonly ActivityDetailBlock[],
  width: number,
  theme: BodyTheme,
) => {
  const key = Arr.join(Arr.map(blocks, blockKey), "\u0001");
  const cached = wrappedDetails.get(shell);
  if (cached?.key === key && cached.width === width) return cached.lines;
  const lines = renderBlocks(blocks, width, theme);
  wrappedDetails.set(shell, { key, width, lines });
  return lines;
};

const detailHeading = (
  { state, row, listFocused }: GroupedBodyContext,
  sameItem: boolean,
  overflow: { readonly start: number; readonly label: string } | undefined,
  width: number,
): string => {
  if (!row) return joinInline(["Summary", overflow?.label]);
  const stale = sameItem && state.loaded?.request.revision !== row.revision;
  const heading = (item: string | undefined) =>
    joinInline([
      listFocused ? "Preview" : "Details",
      item,
      state.follow ? "following" : stale && !listFocused ? "newer output · r Refresh" : undefined,
      overflow?.label,
    ]);
  // Once the breadcrumb scrolls away, the heading keeps naming the item.
  if (!overflow || overflow.start <= 1) return heading(undefined);
  const breadcrumb = Arr.join(state.selected?.breadcrumbs ?? [row.title], " › ");
  const full = heading(breadcrumb);
  return visibleWidth(full) <= width ? full : heading(row.title);
};

function activityDetail(context: GroupedBodyContext, detailHeight: number, detailWidth: number) {
  const { options, state, row, listFocused, interactive } = context;
  const sameItem =
    row !== undefined &&
    state.loaded?.request.key === row.key &&
    state.loaded.request.generation === row.generation;
  const blocks = groupedDetail({
    selected: state.selected,
    theme: options.theme,
    focused: !listFocused,
    now: options.now?.(),
    loaded: sameItem ? state.loaded?.detail : undefined,
    loading: state.loading,
    actionPage: state.actionPage,
    technical: state.technical,
    actions: state.actions,
    children: state.children,
    ownership: row ? activityPath(context.rows, row.key) : [],
  });
  const showHeading = detailHeight > 1;
  const details = state.shell.detailWindow(
    wrappedDetail(state.shell, blocks, detailWidth, options.theme),
    detailHeight - Number(showHeading),
    state.detailPosition,
  );
  if (!showHeading) return details.visible;
  const overflow = details.overflow && {
    start: details.overflow.start,
    label: detailWindowPositionLabel(details.overflow),
  };
  return [
    paneHeading(
      options.theme,
      clipToWidth(detailHeading(context, sameItem, overflow, detailWidth), detailWidth, "…"),
      !listFocused && interactive,
    ),
    ...details.visible,
  ];
}

interface TitlePart {
  readonly text: string;
  readonly tone?: ManagerStatusColor | undefined;
}

// A narrow title drops its item count, then parent waits, before it clips. Attention counts take
// the tones their row glyphs use.
const activityTitle = (
  theme: ActivityComponentOptions["theme"],
  items: string | undefined,
  counts: ActivityAttentionCounts,
  startup: string,
  following: boolean,
  width: number,
): string => {
  const title = (
    count: string | undefined,
    attention: ActivityAttentionCounts,
  ): ReadonlyArray<TitlePart> => [
    { text: "Activity" },
    ...(count ? [{ text: count }] : []),
    ...Arr.map(activityAttentionParts(attention), (part) => ({
      text: part.label,
      tone: part.tone,
    })),
    ...(following ? [{ text: "following" }] : []),
  ];
  const plainTitle = (parts: ReadonlyArray<TitlePart>) =>
    ` ${joinInline(Arr.map(parts, (part) => part.text))}${startup ? ` ${startup}` : ""} `;
  // Parent waits go last; their rows and section still say so.
  const candidates = [
    title(items, counts),
    title(undefined, counts),
    title(undefined, { ...counts, parent: 0 }),
  ];
  const chosen = Option.getOrElse(
    Arr.findFirst(candidates, (candidate) => visibleWidth(plainTitle(candidate)) <= width),
    () => candidates.at(-1) ?? [],
  );
  const accent = (text: string) => theme.fg("accent", text);
  const painted = Arr.join(
    Arr.map(chosen, (part) => (part.tone ? theme.fg(part.tone, part.text) : accent(part.text))),
    accent(" · "),
  );
  return `${accent(" ")}${painted}${accent(`${startup ? ` ${startup}` : ""} `)}`;
};

export function renderGroupedActivity(
  options: ActivityComponentOptions,
  state: GroupedActivityState,
  width: number,
): string[] {
  const { shell, entries, selected } = state;
  const rows = options.snapshot();
  const height = Math.max(0, options.height());
  const arrangement = shell.syncArrangement(width, height);
  const inner = Math.max(0, width - 2);
  // A pending confirmation holds the keys, so neither pane shows focus.
  const frame = listDetailFrame(options.theme, state.confirmation ? undefined : shell.state.pane);
  const urgent = needsYou(rows);
  const counts = summarizeGroup(rows).attention;
  const startup = activityStartupGlyph(rows, options.starting?.() ?? 0, options.now?.());
  const labels = configuredKeyLabels(options.keybindingLabel, activityShortcuts);
  const cancel = labels.binding("tui.select.cancel", "Esc");
  const keys: ActivityKeys = {
    confirm: labels.primary("tui.select.confirm", "Enter"),
    cancel: cancel.key,
    cancelAliases: cancel.aliases,
    move: labels.movement ?? "↑↓",
  };
  const listFocused = shell.state.pane === "list";
  const row = groupedActivitySource(selected);
  const context: GroupedBodyContext = {
    options,
    state,
    rows,
    urgent,
    row,
    listFocused,
    interactive: state.confirmation === undefined,
  };
  const actions = activityActionHints(
    row?.retained ? [] : state.actions,
    state.actionPage,
    selected?.type === "section",
  );
  const enter =
    selected?.type === "section"
      ? selected.expanded
        ? "Fold"
        : "Unfold"
      : selected
        ? "Inspect"
        : undefined;
  // The border keeps the exit and the help toggle; other pairs wrap into rows above it.
  const footer = state.confirmation
    ? { border: confirmationFooter(state.confirmation, keys, inner), overflow: "" }
    : navigationHints(
        listFocused,
        entries.length === 0,
        actions,
        {
          follow: state.follow,
          canFollow: row !== undefined && activityCanFollow(row),
          selectable: row !== undefined && !row.retained,
          enter,
          waiting: urgent.length > 0,
          filter: state.filter ? (state.filter.typing ? "typing" : "applied") : "none",
        },
        keys,
        state.alternateHelp,
        inner,
      );
  const bottom = footer.border;
  const help = footer.overflow
    ? keyHintRows(footer.overflow, inner, (line) => options.theme.fg("dim", line))
    : [];
  const textWidth = Math.max(1, inner - 2 * FRAME_GUTTER);
  const panes = (
    bodyHeight: number,
    { listWidth, detailWidth }: { readonly listWidth: number; readonly detailWidth: number },
  ): ReadonlyArray<string> => {
    const listHeight =
      arrangement === "stacked"
        ? Math.min(
            bodyHeight,
            stackedListHeight(
              bodyHeight,
              activityListLines(context, listWidth, Math.floor(bodyHeight * 0.4)),
            ),
          )
        : bodyHeight;
    const list = activityList(context, listHeight, listWidth);
    // An empty list has no item to describe.
    const detailRows = entries.length
      ? activityDetail(
          context,
          arrangement === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight,
          arrangement === "columns" ? Math.max(1, detailWidth - 2 * FRAME_GUTTER) : textWidth,
        )
      : [];
    const detail = framedGutter(detailRows, arrangement === "columns" ? detailWidth : inner);
    if (arrangement === "columns")
      return framedWideRows(frame, {
        left: list,
        right: detail,
        height: bodyHeight,
        listWidth,
        detailWidth,
      });
    if (arrangement === "stacked")
      return framedStackedRows(frame, { list, detail, height: bodyHeight, inner });
    return framedFill(
      frame,
      shell.state.details ? detail : list,
      bodyHeight,
      inner,
      shell.state.pane,
    );
  };
  return Arr.map(
    framedScreen(frame, {
      width,
      height,
      top: clipToWidth(
        activityTitle(
          options.theme,
          state.itemCount ? countLabel(state.itemCount, "item") : undefined,
          counts,
          startup,
          // Without a visible detail heading, the title says the cursor row is followed.
          state.follow && arrangement === "single" && !shell.state.details,
          Math.max(0, inner - 2),
        ),
        inner,
        "…",
      ),
      bottom,
      body: (fullHeight) => {
        // Wrapped or expanded hints take rows at the bottom so each stays readable at any width.
        const geometry =
          arrangement === "columns"
            ? wideListDetailGeometry(width, ACTIVITY_LIST_MIN_WIDTH, ACTIVITY_LIST_SHARE)
            : { listWidth: inner, detailWidth: Math.max(1, inner) };
        const columns = arrangement === "columns" ? geometry : undefined;
        const confirmation = state.confirmation;
        // A confirmation keeps the panes in view above it, in a band over the border's keys.
        return confirmation
          ? framedBodyWithPrompt(
              frame,
              {
                height: fullHeight,
                inner,
                prompt: options.theme.fg("warning", confirmation.text),
                columns,
              },
              (bodyHeight) => panes(bodyHeight, geometry),
            )
          : framedBodyWithHints(
              frame,
              { height: fullHeight, inner, hints: help, columns },
              (bodyHeight) => panes(bodyHeight, geometry),
            );
      },
    }),
    (line) => clipToWidth(line, width, ""),
  );
}
