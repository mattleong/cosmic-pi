import { countLabel } from "pi-cosmic-core";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { focusedField } from "../manager/style.ts";
import {
  renderResponsiveManagerFooter,
  clipToWidth,
  type ManagerFooterGroup,
} from "../manager/chrome.ts";
import { filterReservedKeyLabel } from "../manager/key-labels.ts";
import type { FullScreenSelectionKeybindingId } from "../manager/keymap.ts";
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
import { activityActionHints, type ActivityActionHints } from "./action-keys.ts";
import { activityAttentionLabels, activityAttentionTotals } from "./attention.ts";
import { needsYou } from "./tree.ts";
import { activityStartupGlyph, activityOwnerLabel } from "./widget.ts";
import { groupedMemberLine } from "./row-line.ts";
import { workflowRowLine } from "./workflow-row.ts";
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

/** The pending action named, with the keys that confirm it, then a plain confirm. */
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

/**
 * The full help, widest first. Action keys outrank zoom and follow once space runs out, and the
 * narrowest variants fall back to bare keys.
 */
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
    /** A pending action's question, its label and the direct key that also confirms it. */
    readonly confirmation:
      | { readonly text: string; readonly label: string; readonly key: string | undefined }
      | undefined;
    readonly follow: boolean;
    readonly technical: boolean;
    /** Where the detail window places its slice this frame. */
    readonly detailPosition: DetailWindowPosition;
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
      const showHeading = listHeight > 1;
      const showNeedsYou = urgent.length > 0 && listHeight > 2;
      const window = shell.visibleWindow(
        entries.length,
        listHeight - Number(showHeading) - Number(showNeedsYou),
      );
      // History rows recede through their identity tone, so every row keeps one guide column.
      const list = entries.slice(window.start, window.end).map((entry) => {
        const isSelected = entry.id === selected?.id;
        const prefix = isSelected ? "> " : "  ";
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
        state.detailPosition,
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
