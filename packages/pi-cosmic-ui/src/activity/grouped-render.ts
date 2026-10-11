import { countLabel } from "pi-cosmic-core";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { focusedField } from "../manager/style.ts";
import {
  renderResponsiveManagerFooter,
  clipToWidth,
  type ManagerFooterGroup,
} from "../manager/chrome.ts";
import { configuredKeyLabels } from "../manager/key-labels.ts";
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
  listDetailHeading,
  type ListDetailShell,
} from "../manager/list-detail-shell.ts";
import { activityActionHints, activityShortcuts, type ActivityActionHints } from "./action-keys.ts";
import { activityAttentionLabels, needsYou } from "./attention.ts";
import { activityStartupGlyph, activityOwnerLabel } from "./widget.ts";
import { groupedMemberLine } from "./row-line.ts";
import { workflowRowLine } from "./workflow-row.ts";
import { groupedActivitySource, type GroupedActivityRow } from "./grouped-tree.ts";
import { groupSummaryLabels, summarizeGroup } from "./group-summary.ts";
import { groupedDetail } from "./grouped-detail.ts";
import type { ActivityComponentOptions } from "./component.ts";
import type { ActivityDetailRequest } from "./service.ts";
import type { ActivityRow } from "./model.ts";

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
  if (entry.type !== "section")
    return workflowRowLine(entry, width, paint, "manager", focusedStyle);
  const fold = entry.children ? (entry.expanded ? "▾ " : "▸ ") : "  ";
  const summary = groupSummaryLabels(entry.summary).join(" · ");
  return clipToWidth(
    `${theme.fg("dim", fold)}${focused ? focusedField(theme, entry.title) : theme.fg("accent", entry.title)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
    width,
    "…",
  );
}

function confirmationFooterVariants(
  confirmation: { readonly label: string; readonly key: string | undefined },
  confirm: string,
  cancel: string,
): ReadonlyArray<ReadonlyArray<ManagerFooterGroup>> {
  const keys = confirmation.key ? `${confirmation.key}/${confirm}` : confirm;
  return [
    [`${keys} ${confirmation.label}`, `${cancel} Cancel`],
    [`${keys} Confirm`, `${cancel} Cancel`],
  ];
}

function helpFooterVariants(
  actions: ActivityActionHints,
  follow: string | undefined,
  back: string,
  cancel: string,
): ReadonlyArray<ReadonlyArray<ManagerFooterGroup>> {
  const bare = (keys: ReadonlyArray<string>) => keys.join(" · ");
  const views = follow ? ["f", "t"] : [];
  const keyed = actions.all
    ? [
        [actions.all, follow, back],
        [actions.all, back],
        [bare(["z", "w", ...actions.keys, "r", ...views]), back],
        [bare(actions.keys), back],
      ]
    : [
        ["z Zoom · w Needs you", follow, back],
        [bare(["z", "w", "r", ...views]), back],
      ];
  return [
    [
      "C-u/d Half-page · PgUp/PgDn Page · gg/G Ends",
      "z Zoom · w Next needing you",
      actions.all,
      follow,
      `r Refresh · ? Back · ${cancel}/q Close`,
    ],
    ["z Zoom · w Needs you", actions.all, follow, back],
    ...keyed,
  ];
}

interface GroupedActivityState {
  readonly shell: ListDetailShell;
  readonly entries: readonly GroupedActivityRow[];
  readonly selected: GroupedActivityRow | undefined;
  readonly alternateHelp: boolean;
  readonly actionPage: number;
  readonly loaded: { readonly request: ActivityDetailRequest; readonly text: string } | undefined;
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
  return options.theme.fg(
    "warning",
    `Needs you [w]: ${activityOwnerLabel(rows, first, Math.max(0, listWidth - 15 - more.length))}${more}`,
  );
}

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
  const list = entries.slice(window.start, window.end).map((entry) => {
    const isSelected = entry.id === selected?.id;
    const prefix = isSelected ? "> " : "  ";
    return padListDetailRow(
      `${prefix}${rowLine(entry, Math.max(0, listWidth - prefix.length), options, isSelected && listFocused)}`,
      listWidth,
    );
  });
  if (!list.length) list.push(options.theme.fg("dim", "No activity yet"));
  if (first) list.unshift(needsYouLine(context, first, listWidth));
  if (showHeading)
    list.unshift(
      listDetailHeading(
        options.theme,
        entries.length
          ? `Activity · ${window.start + 1}–${Math.min(window.end, entries.length)} of ${entries.length}`
          : "Activity · none",
        listFocused,
      ),
    );
  while (list.length < listHeight) list.push("");
  return list;
}

function activityDetail(
  { options, state, row, listFocused }: GroupedBodyContext,
  detailHeight: number,
  detailWidth: number,
) {
  const sameItem =
    row &&
    state.loaded?.request.key === row.key &&
    state.loaded.request.generation === row.generation;
  const detailText = groupedDetail({
    selected: state.selected,
    theme: options.theme,
    focused: !listFocused,
    now: options.now?.(),
    loaded: sameItem ? state.loaded?.text : undefined,
    actionPage: state.actionPage,
    technical: state.technical,
  });
  const showFreshness = detailHeight > 1;
  const details = state.shell.detailWindow(
    detailText.split("\n").flatMap((line) => wrapTextWithAnsi(line, detailWidth)),
    detailHeight - Number(showFreshness),
    state.detailPosition,
  );
  if (!showFreshness) return details.visible;
  const freshness = row
    ? `${sameItem && state.loaded?.request.revision !== row.revision ? "Older output" : "Output"} · r refresh · follow ${state.follow ? "on" : "off"}`
    : "Summary · no execution actions";
  return [
    options.theme.fg("dim", clipToWidth(freshness, detailWidth, "…")),
    ...(details.overflow
      ? [options.theme.fg("dim", detailWindowPositionLabel(details.overflow))]
      : []),
    ...details.visible,
  ];
}

export function renderGroupedActivity(
  options: ActivityComponentOptions,
  state: GroupedActivityState,
  width: number,
): string[] {
  if (width <= 0) return [];
  const { shell, entries, selected } = state;
  const rows = options.snapshot();
  const tier = shell.syncLayout(width);
  shell.ensureSelectionPane(!!selected);
  const height = Math.max(0, options.height());
  const inner = Math.max(0, width - 2);
  const frame = listDetailFrame(options.theme, shell.state.pane);
  const urgent = needsYou(rows);
  const attention = activityAttentionLabels(summarizeGroup(rows).attention).join(" · ");
  const startup = activityStartupGlyph(rows, options.starting?.() ?? 0, options.now?.());
  const { key: hint } = configuredKeyLabels(options.keybindingLabel, activityShortcuts);
  const confirm = hint("tui.select.confirm", "Enter");
  const cancel = hint("tui.select.cancel", "Esc");
  const movement = `${hint("tui.select.up", "↑")}/${hint("tui.select.down", "↓")}`;
  const listFocused = shell.state.pane === "list";
  const row = groupedActivitySource(selected);
  const context: GroupedBodyContext = { options, state, rows, urgent, row, listFocused };
  const navigation = listFocused
    ? `${movement}/j/k Move · h/l Collapse/expand · ${confirm} Inspect`
    : `j/k Scroll · h/${cancel} Back`;
  const shortNavigation = listFocused ? `j/k · ${confirm} Inspect` : "j/k · h Back";
  const actions = activityActionHints(row, state.actionPage);
  const follow = row ? `f ${state.follow ? "Unfollow" : "Follow"} · t Technical` : undefined;
  const bottom = renderResponsiveManagerFooter(
    inner,
    state.confirmation
      ? confirmationFooterVariants(state.confirmation, confirm, cancel)
      : state.alternateHelp
        ? helpFooterVariants(actions, follow, `? Back · ${cancel}/q`, cancel)
        : [
            [
              navigation,
              actions.primary,
              follow,
              `z Zoom · w Next needing you · r Refresh · ? More · ${cancel}/q Close`,
            ],
            [navigation, actions.primary, `? More · ${cancel}/q`],
            [shortNavigation, actions.primary, `? More · ${cancel}/q`],
            [`j/k · ${confirm}`, actions.primary, `? · ${cancel}/q`],
            [shortNavigation, `? More · ${cancel}/q`],
          ],
  );
  return framedScreen(frame, {
    width,
    height,
    top: options.theme.fg(
      "accent",
      clipToWidth(
        ` ${options.title ?? "/activity"} · ${countLabel(rows.length, "item")}${attention ? ` · ${attention}` : ""}${startup ? ` ${startup}` : ""} `,
        inner,
        "",
      ),
    ),
    bottom,
    body: (bodyHeight) => {
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
      const { listWidth, detailWidth } =
        tier === "wide"
          ? wideListDetailGeometry(width, 38, 0.42)
          : { listWidth: inner, detailWidth: Math.max(1, inner) };
      const list = activityList(context, listHeight, listWidth);
      const detailRows = activityDetail(
        context,
        tier === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight,
        detailWidth,
      );
      if (tier === "wide")
        return framedWideRows(frame, {
          left: list,
          right: detailRows,
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
    },
  }).map((line) => clipToWidth(line, width, ""));
}
