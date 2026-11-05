import { countLabel } from "pi-cosmic-core/display";
import {
  Markdown,
  visibleWidth,
  wrapTextWithAnsi,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";
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
} from "../manager/chrome.ts";
import {
  configuredKeyLabels,
  exitKeyHint,
  exitKeyVerb,
  fittedBorderKeyHint,
  framedKeyHintBar,
  joinKeyHints,
  keyHint,
  keyHintRows,
  moveKeyHint,
  type KeyHintBar,
} from "../manager/key-labels.ts";
import {
  detailWindowPositionLabel,
  stackedListHeight,
  wideListDetailGeometry,
  type DetailWindowPosition,
} from "../manager/list-detail.ts";
import {
  FRAME_GUTTER,
  framedBodyWithHints,
  framedFill,
  framedGutter,
  framedScreen,
  framedWideRows,
  framedStackedRows,
  detailFieldRows,
  listDetailFrame,
  type ListDetailShell,
} from "../manager/list-detail-shell.ts";
import { activityActionHints, activityShortcuts, type ActivityActionHints } from "./action-keys.ts";
import { activityAttentionLabels, needsYou, type ActivityAttentionCounts } from "./attention.ts";
import { activityStartupGlyph, activityOwnerLabel } from "./widget.ts";
import { groupedMemberLines } from "./row-line.ts";
import { groupedActivitySource, type GroupedActivityRow } from "./grouped-tree.ts";
import { groupSummaryLabels, summarizeGroup } from "./group-summary.ts";
import { groupedDetail, type ActivityDetailBlock } from "./grouped-detail.ts";
import type { ActivityComponentOptions } from "./component.ts";
import type { ActivityDetailRequest } from "./service.ts";
import { isFinished, type ActivityRow } from "./model.ts";
import type { ActivityDetail } from "./protocol.ts";

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

/** The Activity bar; an empty list offers nothing to move through or inspect. */
const navigationBar = (
  listFocused: boolean,
  empty: boolean,
  actions: ActivityActionHints,
  view: { readonly follow: boolean; readonly selectable: boolean; readonly live: boolean },
  keys: ActivityKeys,
): KeyHintBar => {
  // Finished work no longer changes, so there is nothing to follow.
  const follow =
    view.selectable && view.live ? keyHint("f", view.follow ? "Unfollow" : "Follow") : undefined;
  const technical = view.selectable ? keyHint("t", "Technical") : undefined;
  const refresh = view.selectable ? keyHint("r", "Refresh") : undefined;
  const paging = [
    keyHint("C-u/C-d", "Half-page"),
    keyHint("PgUp/PgDn", "Page"),
    keyHint("gg/G", "Ends"),
  ];
  if (listFocused)
    return {
      hints: empty
        ? []
        : [moveKeyHint(keys.move), keyHint(keys.confirm, "Inspect"), actions.primary, follow],
      more: empty
        ? []
        : [
            keyHint("j/k", "Move"),
            keyHint("h/l", "Fold"),
            ...paging,
            technical,
            keyHint("z", "Zoom"),
            JUMP_TO_INPUT,
            refresh,
          ],
      exit: "top",
      exitKey: keys.cancel,
      exitAliases: [...keys.cancelAliases, "q"],
    };
  return {
    hints: [keyHint(keys.move, "Scroll"), actions.primary, follow, technical],
    more: [
      keyHint("j/k", "Scroll"),
      ...paging,
      keyHint("z", "Zoom"),
      JUMP_TO_INPUT,
      refresh,
      keyHint("q", exitKeyVerb("top")),
    ],
    exit: "nested",
    exitKey: keys.cancel,
    exitAliases: [...keys.cancelAliases, "h"],
  };
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

function activityList(
  context: GroupedBodyContext,
  listHeight: number,
  listWidth: number,
): string[] {
  const { options, state, urgent, listFocused } = context;
  const { shell, entries, selected } = state;
  const showHeading = listHeight > 1;
  // Text keeps a one-column gutter on each side, off the frame and the pane divider.
  const textWidth = Math.max(0, listWidth - 2 * FRAME_GUTTER);
  const rowWidth = Math.max(0, textWidth - CURSOR.length);
  const rows = listHeight - Number(showHeading);
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
      ...Arr.map(wrapTextWithAnsi(EMPTY_ACTIVITY, Math.max(1, textWidth)), (line) =>
        options.theme.fg("dim", line),
      ),
    );
  if (first) list.unshift(needsYouLine({ ...context, urgent: unseen }, first, textWidth));
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
          textWidth,
          "…",
        ),
        listFocused,
      ),
    );
  }
  const body = framedGutter(list.slice(0, listHeight), listWidth);
  while (body.length < listHeight) body.push("");
  return body;
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
    Match.value(block).pipe(
      Match.discriminatorsExhaustive("kind")({
        markdown: ({ text }) => new Markdown(text, 0, 0, markdownTheme(theme)).render(width),
        facts: ({ text }) => Arr.map(wrapFacts(text, width), (line) => theme.fg("muted", line)),
        fields: ({ fields }) => [...detailFieldRows(theme, fields, width)],
        text: ({ text }) => wrapVerbatim(text, width),
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

// A narrow title drops its item count, then parent waits, before it clips.
const activityTitle = (
  items: string | undefined,
  counts: ActivityAttentionCounts,
  startup: string,
  following: boolean,
  width: number,
): string => {
  const title = (count: string | undefined, attention: ActivityAttentionCounts) =>
    ` ${joinInline(["Activity", count, ...activityAttentionLabels(attention), following ? "following" : undefined])}${startup ? ` ${startup}` : ""} `;
  // Parent waits go last; their rows and section still say so.
  const candidates = [
    title(items, counts),
    title(undefined, counts),
    title(undefined, { ...counts, parent: 0 }),
  ];
  return Option.getOrElse(
    Arr.findFirst(candidates, (candidate) => visibleWidth(candidate) <= width),
    () => candidates.at(-1) ?? "",
  );
};

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
  const context: GroupedBodyContext = { options, state, rows, urgent, row, listFocused };
  const actions = activityActionHints(row, state.actionPage);
  const navigation = navigationBar(
    listFocused,
    entries.length === 0,
    actions,
    {
      follow: state.follow,
      selectable: row !== undefined && !row.retained,
      live: row !== undefined && !isFinished(row),
    },
    keys,
  );
  // The border keeps the exit and the help toggle; other pairs wrap into rows above it.
  const footer = state.confirmation
    ? { border: confirmationFooter(state.confirmation, keys, inner), overflow: "" }
    : framedKeyHintBar(navigation, state.alternateHelp, inner);
  const bottom = footer.border;
  const help = footer.overflow
    ? keyHintRows(footer.overflow, inner, (line) => options.theme.fg("dim", line))
    : [];
  const textWidth = Math.max(1, inner - 2 * FRAME_GUTTER);
  const activityBody = (
    bodyHeight: number,
    { listWidth, detailWidth }: { readonly listWidth: number; readonly detailWidth: number },
  ): ReadonlyArray<string> => {
    if (state.confirmation)
      return framedFill(
        frame,
        framedGutter(wrapTextWithAnsi(state.confirmation.text, textWidth), inner),
        bodyHeight,
        inner,
      );
    const listHeight =
      tier === "stacked"
        ? Math.min(bodyHeight, stackedListHeight(bodyHeight, entries.length))
        : bodyHeight;
    const list = activityList(context, listHeight, listWidth);
    // An empty list has no item to describe.
    const detailRows = entries.length
      ? activityDetail(
          context,
          tier === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight,
          tier === "wide" ? Math.max(1, detailWidth - 2 * FRAME_GUTTER) : textWidth,
        )
      : [];
    const detail = framedGutter(detailRows, tier === "wide" ? detailWidth : inner);
    if (tier === "wide")
      return framedWideRows(frame, {
        left: list,
        right: detail,
        height: bodyHeight,
        listWidth,
        detailWidth,
      });
    if (tier === "stacked")
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
      top: options.theme.fg(
        "accent",
        clipToWidth(
          activityTitle(
            state.itemCount ? countLabel(state.itemCount, "item") : undefined,
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
            ? wideListDetailGeometry(width, ACTIVITY_LIST_MIN_WIDTH, ACTIVITY_LIST_SHARE)
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
