import { countLabel } from "pi-cosmic-core/display";
import {
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { LIST_CURSOR, focusedField } from "../manager/style.ts";
import {
  clipToWidth,
  joinInline,
  managerNoticeColor,
  managerNoticeGlyph,
} from "../manager/chrome.ts";
import {
  borderKeyHint,
  configuredKeyLabels,
  exitKeyHint,
  exitKeyVerb,
  fittedBorderKeyHint,
  framedKeyHints,
  helpKeyHint,
  joinKeyHints,
  keyHint,
  keyHintRows,
  moveKeyHint,
} from "../manager/key-labels.ts";
import {
  detailWindowPositionLabel,
  padListDetailRow,
  stackedListHeight,
  wideListDetailGeometry,
  type DetailWindowPosition,
} from "../manager/list-detail.ts";
import {
  framedBodyWithHints,
  framedFill,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  listDetailFrame,
  type ListDetailShell,
} from "../manager/list-detail-shell.ts";
import { activityActionHints, activityShortcuts, type ActivityActionHints } from "./action-keys.ts";
import {
  activityAttentionLabels,
  compactNotices,
  needsYou,
  type ActivityAttentionCounts,
} from "./attention.ts";
import { activityStartupGlyph, activityOwnerLabel } from "./widget.ts";
import { groupedMemberLine } from "./row-line.ts";
import { groupedActivitySource, type GroupedActivityRow } from "./grouped-tree.ts";
import { groupSummaryLabels, summarizeGroup } from "./group-summary.ts";
import { groupedDetail, type ActivityDetailBlock } from "./grouped-detail.ts";
import type { ActivityComponentOptions } from "./component.ts";
import type { ActivityDetailRequest } from "./service.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityDetail } from "./protocol.ts";

const CURSOR = `${LIST_CURSOR} `;
const NO_CURSOR = "  ";

function rowLine(
  entry: GroupedActivityRow,
  width: number,
  options: ActivityComponentOptions,
  focused: boolean,
): string {
  const theme = options.theme;
  const focusedStyle = focused ? (text: string) => focusedField(theme, text) : undefined;
  const paint = { now: options.now?.(), theme };
  if (entry.type === "member")
    return groupedMemberLine(entry, width, paint, "manager", focusedStyle);
  const fold = entry.children ? (entry.expanded ? "▾ " : "▸ ") : "  ";
  const full = joinInline(groupSummaryLabels(entry.summary));
  const summary =
    visibleWidth(`${fold}${entry.title} · ${full}`) <= width
      ? full
      : joinInline(groupSummaryLabels(entry.summary, true));
  return clipToWidth(
    `${theme.fg("dim", fold)}${focused ? focusedField(theme, entry.title) : theme.fg("accent", entry.title)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
    width,
    "…",
  );
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

interface NavigationHints {
  readonly hints: ReadonlyArray<string | undefined>;
  readonly more: ReadonlyArray<string | undefined>;
  readonly close: string;
}

const navigationHints = (
  listFocused: boolean,
  actions: ActivityActionHints,
  view: { readonly follow: boolean; readonly selectable: boolean; readonly live: boolean },
  keys: ActivityKeys,
): NavigationHints => {
  // Finished work no longer changes, so there is nothing to follow.
  const follow =
    view.selectable && view.live ? keyHint("f", view.follow ? "Unfollow" : "Follow") : undefined;
  const technical = view.selectable ? keyHint("t", "Technical") : undefined;
  const exit = listFocused ? "top" : "nested";
  return {
    hints: listFocused
      ? [moveKeyHint(keys.move), keyHint(keys.confirm, "Inspect"), actions.primary, follow]
      : [keyHint(keys.move, "Scroll"), actions.primary, follow, technical],
    more: [
      listFocused ? "j/k Move · h/l Fold" : "j/k Scroll · h Back",
      "C-u/C-d Half-page · PgUp/PgDn Page · gg/G Ends",
      listFocused ? technical : undefined,
      "z Zoom",
      "w Next input",
      view.selectable ? "r Refresh" : undefined,
      keys.cancelAliases.length
        ? keyHint(Arr.join(keys.cancelAliases, "/"), exitKeyVerb(exit))
        : undefined,
      "q Close",
    ],
    close: exitKeyHint(exit, [], keys.cancel),
  };
};

interface NavigationFooter {
  readonly bottom: string;
  /** Hints that didn't fit the border, shown in wrapped rows above it. */
  readonly overflow: string | undefined;
}

/**
 * The bottom border carries the whole bar when it fits. Otherwise it keeps exit and help, and
 * the other hints wrap between pairs into rows above it, so none is dropped at any width.
 * Expanded help always lists everything above the border.
 */
function navigationFooter(
  { hints, close }: NavigationHints,
  expanded: boolean,
  inner: number,
): NavigationFooter {
  const tail = [close, helpKeyHint(expanded)];
  if (expanded) return { bottom: borderKeyHint(joinKeyHints(tail), inner), overflow: undefined };
  const { border, overflow } = framedKeyHints(hints, tail, inner);
  return { bottom: border, overflow: overflow || undefined };
}

/**
 * Expanded help lists every default hint plus aliases, paging, and the remaining views; the
 * bottom bar keeps the exit and help toggle.
 */
const expandedHelp = ({ hints, more }: NavigationHints): string =>
  joinKeyHints([...hints, ...more]);

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
}

interface GroupedBodyContext {
  readonly options: ActivityComponentOptions;
  readonly state: GroupedActivityState;
  readonly rows: readonly ActivityRow[];
  readonly urgent: readonly ActivityRow[];
  readonly row: ActivityRow | undefined;
  readonly listFocused: boolean;
}

function needsYouLine(
  { options, rows, urgent }: GroupedBodyContext,
  first: ActivityRow,
  listWidth: number,
): string {
  const more = urgent.length > 1 ? ` +${urgent.length - 1}` : "";
  const jump = " · w Jump";
  const prefix = `${managerNoticeGlyph("attention")} Needs your input: `;
  return options.theme.fg(
    managerNoticeColor("attention"),
    clipToWidth(
      `${prefix}${activityOwnerLabel(rows, first, Math.max(0, listWidth - prefix.length - more.length - jump.length))}${more}${jump}`,
      listWidth,
      "…",
    ),
  );
}

const paneHeading = (
  theme: ActivityComponentOptions["theme"],
  text: string,
  focused: boolean,
): string => (focused ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text));

function activityList(
  context: GroupedBodyContext,
  listHeight: number,
  listWidth: number,
): string[] {
  const { options, state, urgent, listFocused } = context;
  const { shell, entries, selected } = state;
  const showHeading = listHeight > 1;
  const listed = (start: number, end: number) =>
    new Set(
      Arr.flatMap(entries.slice(start, end), (entry) =>
        entry.type === "member" ? [entry.row.key] : [],
      ),
    );
  // The banner points at waiting work the list doesn't show; a visible row speaks for itself.
  const rows = listHeight - Number(showHeading);
  const full = shell.visibleWindow(entries.length, rows);
  const shown = listed(full.start, full.end);
  const unseen = Arr.filter(urgent, (row) => !shown.has(row.key));
  const first = listHeight > 2 ? unseen[0] : undefined;
  const window = first ? shell.visibleWindow(entries.length, rows - 1) : full;
  // A one-column gutter keeps right-aligned times off the frame and the pane divider.
  const rowWidth = Math.max(0, listWidth - CURSOR.length - 1);
  const list = Arr.map(entries.slice(window.start, window.end), (entry) => {
    const isSelected = entry.id === selected?.id;
    const prefix = isSelected ? CURSOR : NO_CURSOR;
    return padListDetailRow(
      `${isSelected ? options.theme.fg("accent", prefix) : prefix}${rowLine(entry, rowWidth, options, isSelected && listFocused)}`,
      listWidth,
    );
  });
  if (!list.length) list.push(options.theme.fg("dim", "No activity yet"));
  if (first) list.unshift(needsYouLine({ ...context, urgent: unseen }, first, listWidth));
  if (showHeading) {
    const above = window.start;
    const below = Math.max(0, entries.length - window.end);
    list.unshift(
      paneHeading(
        options.theme,
        clipToWidth(
          joinInline([
            "Items",
            above ? `${above} more above` : undefined,
            below ? `${below} more below` : undefined,
          ]),
          listWidth,
          "…",
        ),
        listFocused,
      ),
    );
  }
  while (list.length < listHeight) list.push("");
  return list;
}

type BodyTheme = ActivityComponentOptions["theme"];

const plain = (text: string) => text;

const markdownTheme = (theme: BodyTheme): MarkdownTheme => {
  return {
    heading: (text) => theme.fg("mdHeading", theme.bold(text)),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: plain,
    strikethrough: plain,
    underline: plain,
  };
};

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
    block.kind === "markdown"
      ? new Markdown(block.text, 0, 0, markdownTheme(theme)).render(width)
      : wrapVerbatim(block.text, width),
  );

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
  const key = Arr.join(
    Arr.map(blocks, (block) => `${block.kind}\u0000${block.text}`),
    "\u0001",
  );
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
  const { options, state, row, listFocused } = context;
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
      !listFocused,
    ),
    ...details.visible,
  ];
}

// A narrow title shortens parent waits before it clips, so attention stays readable.
const activityTitle = (
  items: string,
  counts: ActivityAttentionCounts,
  startup: string,
  following: boolean,
  width: number,
): string => {
  const title = (labels: readonly string[]) =>
    ` ${joinInline(["Activity", items, ...labels, following ? "following" : undefined])}${startup ? ` ${startup}` : ""} `;
  const full = title(activityAttentionLabels(counts));
  return visibleWidth(full) <= width ? full : title(compactNotices(counts));
};

const movementLabel = (up: string, down: string): string =>
  Str.length(up) === 1 && Str.length(down) === 1 ? `${up}${down}` : `${up}/${down}`;

export function renderGroupedActivity(
  options: ActivityComponentOptions,
  state: GroupedActivityState,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { shell, entries, selected } = state;
  const rows = options.snapshot();
  const tier = shell.syncLayout(width);
  shell.ensureSelectionPane(selected !== undefined);
  const height = Math.max(0, options.height());
  const inner = Math.max(0, width - 2);
  const frame = listDetailFrame(options.theme, shell.state.pane);
  const urgent = needsYou(rows);
  const counts = summarizeGroup(rows).attention;
  const startup = activityStartupGlyph(rows, options.starting?.() ?? 0, options.now?.());
  const { key: hint } = configuredKeyLabels(options.keybindingLabel, activityShortcuts);
  const [cancel, ...cancelAliases] = Str.split(hint("tui.select.cancel", "Esc"), "/");
  const keys: ActivityKeys = {
    confirm: hint("tui.select.confirm", "Enter"),
    cancel,
    cancelAliases,
    move: movementLabel(hint("tui.select.up", "↑"), hint("tui.select.down", "↓")),
  };
  const listFocused = shell.state.pane === "list";
  const row = groupedActivitySource(selected);
  const context: GroupedBodyContext = { options, state, rows, urgent, row, listFocused };
  const actions = activityActionHints(row, state.actionPage);
  const navigation = navigationHints(
    listFocused,
    actions,
    {
      follow: state.follow,
      selectable: row !== undefined && !row.retained,
      live: row !== undefined && !isFinished(row),
    },
    keys,
  );
  const footer = state.confirmation
    ? { bottom: confirmationFooter(state.confirmation, keys, inner), overflow: undefined }
    : navigationFooter(navigation, state.alternateHelp, inner);
  const bottom = footer.bottom;
  const hintText =
    state.alternateHelp && !state.confirmation ? expandedHelp(navigation) : footer.overflow;
  const help = hintText
    ? keyHintRows(hintText, inner, (line) => options.theme.fg("dim", line))
    : [];
  const activityBody = (
    bodyHeight: number,
    { listWidth, detailWidth }: { readonly listWidth: number; readonly detailWidth: number },
  ): ReadonlyArray<string> => {
    if (state.confirmation)
      return framedFill(
        frame,
        wrapTextWithAnsi(state.confirmation.text, Math.max(1, inner)),
        bodyHeight,
        inner,
      );
    const listHeight =
      tier === "stacked"
        ? Math.min(bodyHeight, stackedListHeight(bodyHeight, entries.length))
        : bodyHeight;
    const list = activityList(context, listHeight, listWidth);
    const detailRows = activityDetail(
      context,
      tier === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight,
      // A one-column gutter keeps detail text off the pane divider.
      tier === "wide" ? Math.max(1, detailWidth - 1) : detailWidth,
    );
    if (tier === "wide")
      return framedWideRows(frame, {
        left: list,
        right: Arr.map(detailRows, (line) => ` ${line}`),
        height: bodyHeight,
        listWidth,
        detailWidth,
      });
    if (tier === "stacked")
      return framedStackedRows(frame, { list, detail: detailRows, height: bodyHeight, inner });
    return framedFill(
      frame,
      shell.state.details ? detailRows : list,
      bodyHeight,
      inner,
      shell.state.pane,
    );
  };
  return Arr.map(
    framedScreen(frame, {
      width,
      height,
      top: options.theme.fg(
        "accent",
        clipToWidth(
          activityTitle(
            countLabel(state.itemCount, "item"),
            counts,
            startup,
            // Without a visible detail heading, the title says the cursor row is followed.
            state.follow && tier === "narrow" && !shell.state.details,
            Math.max(0, inner - 2),
          ),
          inner,
          "…",
        ),
      ),
      bottom,
      body: (fullHeight) => {
        // Wrapped or expanded hints take rows at the bottom so each stays readable at any width.
        const geometry =
          tier === "wide"
            ? wideListDetailGeometry(width, 38, 0.4)
            : { listWidth: inner, detailWidth: Math.max(1, inner) };
        return framedBodyWithHints(
          frame,
          {
            height: fullHeight,
            inner,
            hints: help,
            columns: tier === "wide" ? geometry : undefined,
          },
          (bodyHeight) => activityBody(bodyHeight, geometry),
        );
      },
    }),
    (line) => clipToWidth(line, width, ""),
  );
}
