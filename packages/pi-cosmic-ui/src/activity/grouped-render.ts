import { countLabel } from "pi-cosmic-core";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { focusedField } from "../manager/style.ts";
import { renderResponsiveManagerFooter, clipToWidth } from "../manager/chrome.ts";
import { filterReservedKeyLabel } from "../manager/key-labels.ts";
import type { FullScreenSelectionKeybindingId } from "../manager/keymap.ts";
import {
  detailWindowPositionLabel,
  padListDetailRow,
  stackedListHeight,
  wideListDetailGeometry,
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
import { activityAttentionLabels, activityAttentionTotals } from "./attention.ts";
import { needsYou } from "./tree.ts";
import {
  activityStartupGlyph,
  activityOwnerLabel,
  groupedMemberLine,
  workflowRowLine,
} from "./widget.ts";
import {
  groupedActivitySource,
  groupSummaryLabels,
  type GroupedActivityRow,
} from "./grouped-tree.ts";
import { groupedDetail } from "./grouped-detail.ts";
import type { ActivityComponentOptions } from "./component.ts";
import type { ActivityDetailRequest } from "./service.ts";

export const activityShortcuts = new Set([
  "a",
  "r",
  "w",
  "z",
  "f",
  "t",
  "x",
  "i",
  "u",
  "m",
  "e",
  "c",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

function rowLine(
  entry: GroupedActivityRow,
  width: number,
  options: ActivityComponentOptions,
  focused: boolean,
): string {
  const theme = options.theme;
  const focusedStyle = focused ? (text: string) => focusedField(theme, text) : undefined;
  if (entry.type === "member")
    return groupedMemberLine(
      entry,
      width,
      { now: options.now?.(), theme },
      "manager",
      focusedStyle,
    );
  if (entry.type === "workflow" || entry.type === "phase")
    return workflowRowLine(entry, width, { now: options.now?.(), theme }, "manager", focusedStyle);
  const prefix = `${"  ".repeat(Math.min(entry.depth, 10))}${entry.children ? (entry.expanded ? "▾ " : "▸ ") : "  "}`;
  const label = entry.title;
  const summary = groupSummaryLabels(entry.summary).join(" · ");
  return clipToWidth(
    `${theme.fg("dim", prefix)}${focused ? focusedField(theme, label) : theme.fg(entry.type === "section" ? "accent" : "text", label)}${summary ? theme.fg("muted", ` · ${summary}`) : ""}`,
    width,
    "…",
  );
}

/** Synchronous presentation only. The component owns all fetching and input transitions. */
export function renderGroupedActivity(
  options: ActivityComponentOptions,
  state: {
    readonly shell: ListDetailShell;
    readonly entries: readonly GroupedActivityRow[];
    readonly selected: GroupedActivityRow | undefined;
    readonly alternateHelp: boolean;
    readonly actionPage: number;
    readonly loaded: { readonly request: ActivityDetailRequest; readonly text: string } | undefined;
    readonly confirmation: string | undefined;
    readonly follow: boolean;
    readonly technical: boolean;
    readonly preserveDetailPosition: boolean;
  },
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
  const attention = activityAttentionLabels(activityAttentionTotals(rows)).join(" · ");
  const startup = activityStartupGlyph(rows, options.starting?.() ?? 0, options.now?.());
  const hint = (id: FullScreenSelectionKeybindingId, fallback: string) =>
    filterReservedKeyLabel(
      options.keybindingLabel?.(id, fallback) ?? fallback,
      activityShortcuts,
      fallback,
    );
  const confirm = hint("tui.select.confirm", "Enter");
  const cancel = hint("tui.select.cancel", "Esc");
  const movement = `${hint("tui.select.up", "↑")}/${hint("tui.select.down", "↓")}`;
  const listFocused = shell.state.pane === "list";
  const row = groupedActivitySource(selected);
  const navigation = listFocused
    ? `${movement}/j/k Move · h/l Collapse/expand · ${confirm} Inspect`
    : `j/k Scroll · h/${cancel} Back`;
  const actionKeys = new Map([
    ["stop", "x"],
    ["skip", "x"],
    ["interrupt", "i"],
    ["resume", "u"],
    ["reply", "m"],
    ["message", "m"],
    ["rename", "e"],
    ["clear", "c"],
    ["clear-finished", "c"],
  ]);
  const directActions = row?.retained
    ? ""
    : row?.actions
        ?.flatMap((action) =>
          actionKeys.has(action.id) ? [`${actionKeys.get(action.id)} ${action.label}`] : [],
        )
        .join(" · ");
  const actions =
    row?.actions?.length && !row.retained ? "1-9 Actions · a More actions" : undefined;
  const follow = row ? `f ${state.follow ? "Unfollow" : "Follow"} · t Technical` : undefined;
  const bottom = renderResponsiveManagerFooter(
    inner,
    state.confirmation
      ? [[`${confirm} Confirm`, `${cancel} Cancel`]]
      : state.alternateHelp
        ? [
            [
              "C-u/d Half-page · PgUp/PgDn Page · gg/G Ends",
              "z Zoom · w Next needing you",
              directActions,
              actions,
              follow,
              `r Refresh · ? Back · ${cancel}/q Close`,
            ],
            ["z Zoom · w Needs you", follow, `? Back · ${cancel}/q`],
            ["z · w · a · r · f · t", `? Back · ${cancel}/q`],
          ]
        : [
            [
              navigation,
              actions,
              follow,
              `z Zoom · w Next needing you · r Refresh · ? More · ${cancel}/q Close`,
            ],
            [navigation, actions, `? More · ${cancel}/q`],
            [listFocused ? `j/k · ${confirm} Inspect` : "j/k · h Back", `? More · ${cancel}/q`],
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
          wrapTextWithAnsi(state.confirmation, Math.max(1, inner)),
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
      const showHeading = listHeight > 1;
      const showNeedsYou = urgent.length > 0 && listHeight > 2;
      const window = shell.visibleWindow(
        entries.length,
        listHeight - Number(showHeading) - Number(showNeedsYou),
      );
      const list = entries.slice(window.start, window.end).map((entry) => {
        const isSelected = entry.id === selected?.id;
        const prefix = `${isSelected ? "> " : "  "}${entry.history ? "H " : ""}`;
        return padListDetailRow(
          `${prefix}${rowLine(entry, Math.max(0, listWidth - prefix.length), options, isSelected && listFocused)}`,
          listWidth,
        );
      });
      if (!list.length) list.push(options.theme.fg("dim", "No activity yet"));
      if (showNeedsYou)
        list.unshift(
          options.theme.fg(
            "warning",
            `Needs you [w]: ${activityOwnerLabel(rows, urgent[0]!, Math.max(0, listWidth - 15 - (urgent.length > 1 ? ` +${urgent.length - 1}`.length : 0)))}${urgent.length > 1 ? ` +${urgent.length - 1}` : ""}`,
          ),
        );
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
      const sameItem =
        row &&
        state.loaded?.request.key === row.key &&
        state.loaded.request.generation === row.generation;
      const freshness = row
        ? `${sameItem && state.loaded?.request.revision !== row.revision ? "Older output" : "Output"} · r refresh · follow ${state.follow ? "on" : "off"}`
        : "Summary · no execution actions";
      const detailText = groupedDetail({
        selected,
        rows,
        theme: options.theme,
        focused: !listFocused,
        now: options.now?.(),
        loaded: sameItem ? state.loaded?.text : undefined,
        actionPage: state.actionPage,
        technical: state.technical,
      });
      const detailHeight =
        tier === "stacked" ? Math.max(0, bodyHeight - listHeight - 1) : bodyHeight;
      const showFreshness = detailHeight > 1;
      const details = shell.detailWindow(
        detailText.split("\n").flatMap((line) => wrapTextWithAnsi(line, detailWidth)),
        detailHeight - Number(showFreshness),
        state.follow ? true : state.preserveDetailPosition ? false : undefined,
      );
      const detailRows = showFreshness
        ? [
            options.theme.fg("dim", clipToWidth(freshness, detailWidth, "…")),
            ...(details.overflow
              ? [options.theme.fg("dim", detailWindowPositionLabel(details.overflow))]
              : []),
            ...details.visible,
          ]
        : details.visible;
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
