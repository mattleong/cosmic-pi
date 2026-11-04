import { countLabel } from "pi-cosmic-core/display";
import { Markdown, wrapTextWithAnsi, type MarkdownTheme } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { LIST_CURSOR, focusedField } from "../manager/style.ts";
import {
  renderResponsiveManagerFooter,
  clipToWidth,
  joinInline,
  managerNoticeColor,
  managerNoticeGlyph,
  type ManagerFooterGroup,
} from "../manager/chrome.ts";
import {
  configuredKeyLabels,
  exitKeyHint,
  helpKeyHint,
  joinKeyHints,
  keyHint,
  moveKeyHint,
  wrapKeyHints,
} from "../manager/key-labels.ts";
import {
  detailWindowPositionLabel,
  padListDetailRow,
  stackedListHeight,
  wideListDetailGeometry,
  type DetailWindowPosition,
} from "../manager/list-detail.ts";
import {
  framedFill,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  listDetailFrame,
  type ListDetailShell,
} from "../manager/list-detail-shell.ts";
import { activityActionHints, activityShortcuts, type ActivityActionHints } from "./action-keys.ts";
import { activityAttentionLabels, needsYou } from "./attention.ts";
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
  const summary = joinInline(groupSummaryLabels(entry.summary));
  return clipToWidth(
    `${theme.fg("dim", fold)}${focused ? focusedField(theme, entry.title) : theme.fg("accent", entry.title)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
    width,
    "…",
  );
}

interface ActivityKeys {
  readonly confirm: string;
  readonly cancel: string;
  readonly move: string;
}

function confirmationFooterVariants(
  confirmation: { readonly label: string; readonly key: string | undefined },
  { confirm, cancel }: ActivityKeys,
): ReadonlyArray<ReadonlyArray<ManagerFooterGroup>> {
  const keys = confirmation.key ? `${confirmation.key}/${confirm}` : confirm;
  const decline = exitKeyHint("decision", [], cancel);
  return [
    [joinKeyHints([keyHint(keys, confirmation.label), decline])],
    [joinKeyHints([keyHint(keys, "Confirm"), decline])],
  ];
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
      actions.all === actions.primary ? undefined : actions.all,
      listFocused ? technical : undefined,
      "z Zoom",
      "w Next needing you",
      view.selectable ? "r Refresh" : undefined,
      "q Close",
    ],
    close: exitKeyHint(exit, [], keys.cancel),
  };
};

// Collapsed bars shed hints from the end as width shrinks; exit and help always remain.
function navigationFooterVariants(
  { hints, close }: NavigationHints,
  expanded: boolean,
): ReadonlyArray<ReadonlyArray<ManagerFooterGroup>> {
  const help = helpKeyHint(expanded);
  if (expanded) return [[joinKeyHints([close, help])]];
  const bar = (shown: ReadonlyArray<string | undefined>) => joinKeyHints([...shown, close, help]);
  return [[bar(hints)], [bar(Arr.take(hints, 3))], [bar(Arr.take(hints, 2))], [bar([])]];
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
  const prefix = `${managerNoticeGlyph("attention")} Needs you: `;
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
  const first = listHeight > 2 ? urgent[0] : undefined;
  const window = shell.visibleWindow(
    entries.length,
    listHeight - Number(showHeading) - Number(first !== undefined),
  );
  const list = Arr.map(entries.slice(window.start, window.end), (entry) => {
    const isSelected = entry.id === selected?.id;
    const prefix = isSelected ? CURSOR : NO_CURSOR;
    return padListDetailRow(
      `${isSelected ? options.theme.fg("accent", prefix) : prefix}${rowLine(entry, Math.max(0, listWidth - prefix.length), options, isSelected && listFocused)}`,
      listWidth,
    );
  });
  if (!list.length) list.push(options.theme.fg("dim", "No activity yet"));
  if (first) list.unshift(needsYouLine(context, first, listWidth));
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
  overflow: string | undefined,
): string => {
  if (!row) return joinInline(["Summary", overflow]);
  const stale = sameItem && state.loaded?.request.revision !== row.revision;
  return joinInline([
    listFocused ? "Preview" : "Details",
    state.follow ? "following" : stale && !listFocused ? "newer output · r Refresh" : undefined,
    overflow,
  ]);
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
  const overflow = details.overflow ? detailWindowPositionLabel(details.overflow) : undefined;
  return [
    paneHeading(
      options.theme,
      clipToWidth(detailHeading(context, sameItem, overflow), detailWidth, "…"),
      !listFocused,
    ),
    ...details.visible,
  ];
}

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
  const attention = joinInline(activityAttentionLabels(summarizeGroup(rows).attention));
  const startup = activityStartupGlyph(rows, options.starting?.() ?? 0, options.now?.());
  const { key: hint } = configuredKeyLabels(options.keybindingLabel, activityShortcuts);
  const keys: ActivityKeys = {
    confirm: hint("tui.select.confirm", "Enter"),
    cancel: hint("tui.select.cancel", "Esc"),
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
  const bottom = renderResponsiveManagerFooter(
    inner,
    state.confirmation
      ? confirmationFooterVariants(state.confirmation, keys)
      : navigationFooterVariants(navigation, state.alternateHelp),
  );
  const help =
    state.alternateHelp && !state.confirmation
      ? Arr.map(wrapKeyHints(expandedHelp(navigation), Math.max(1, inner - 1)), (line) =>
          options.theme.fg("dim", ` ${line}`),
        )
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
          ` ${joinInline(["Activity", countLabel(rows.length, "item"), attention])}${startup ? ` ${startup}` : ""} `,
          inner,
          "",
        ),
      ),
      bottom,
      body: (fullHeight) => {
        // Expanded help takes rows at the bottom so every hint stays readable at any width.
        const helpRows = fullHeight > help.length + 4 ? help : [];
        const bodyHeight = fullHeight - (helpRows.length ? helpRows.length + 1 : 0);
        const geometry =
          tier === "wide"
            ? wideListDetailGeometry(width, 38, 0.4)
            : { listWidth: inner, detailWidth: Math.max(1, inner) };
        const content = activityBody(bodyHeight, geometry);
        if (!helpRows.length) return content;
        const divider =
          tier === "wide"
            ? `${frame.outer("├")}${frame.outer(Fn.pipe("─", Str.repeat(geometry.listWidth)))}${frame.inner("┴")}${frame.outer(Fn.pipe("─", Str.repeat(geometry.detailWidth)))}${frame.outer("┤")}`
            : `${frame.outer("├")}${frame.outer(Fn.pipe("─", Str.repeat(inner)))}${frame.outer("┤")}`;
        return [...content, divider, ...framedFill(frame, helpRows, helpRows.length, inner)];
      },
    }),
    (line) => clipToWidth(line, width, ""),
  );
}
