import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { countLabel, formatRelativeAge, sanitizeTerminalLine } from "pi-cosmic-core";
import { clipToWidth, renderResponsiveManagerFooter, spinnerFrameAt } from "pi-cosmic-ui/manager";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { framedFill, type ListDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import type { SubagentRunView } from "../run/model.ts";
import {
  CONFIRMATION_KEYS,
  FLEET_SHORTCUTS,
  PROMPTS,
  fleetActionLabels,
  type FleetPrompt,
  type PendingConfirmation,
} from "./fleet-policy.ts";
import { shortRunId } from "./run-presentation.ts";
import { runStateColor, runStateGlyph, runStateLabel } from "./run-state.ts";
import { runTreeBranch, type FleetTreeRow } from "./run-tree-rows.ts";

type FleetKeybindingLabel = (id: FullScreenSelectionKeybindingId, fallback: string) => string;

export const fleetTitle = (
  runs: ReadonlyArray<SubagentRunView>,
  visibleRows: number,
  width: number,
): string => {
  const working = Arr.filter(
    runs,
    (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
  ).length;
  const waiting = Arr.filter(runs, (run) => run.state === "waiting_for_parent").length;
  const paused = Arr.filter(runs, (run) => run.state === "paused").length;
  const hidden = runs.length - visibleRows;
  const titleRaw = ` /subagents · ${countLabel(runs.length, "run")}${hidden ? ` · ${visibleRows} visible` : ""}${working ? ` · ${working} running` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""} `;
  return clipToWidth(titleRaw, Math.max(0, width - 2), "");
};

export const renderFleetPrompt = (
  theme: Theme,
  frame: ListDetailFrame,
  prompt: FleetPrompt,
  width: number,
  height: number,
): string[] => {
  const inner = Math.max(0, width - 2);
  const { title, instruction } = PROMPTS[prompt.kind];
  const heading = theme.fg("accent", theme.bold(`${title} ${prompt.runName}`));
  const hint = theme.fg("dim", instruction);
  const inputLines = prompt.input.render(Math.max(1, inner)).slice(0, 1);
  const feedback = prompt.feedback ? [theme.fg("warning", prompt.feedback)] : [];
  const contextLines = prompt.context
    ? wrapTextWithAnsi(theme.fg("warning", `Question: ${prompt.context}`), Math.max(1, inner))
    : [];
  const rows =
    height <= 1
      ? inputLines
      : height === 2
        ? [...inputLines, ...(feedback.length > 0 ? feedback : [hint])]
        : height === 3 && feedback.length > 0
          ? [heading, ...inputLines, ...feedback]
          : [
              heading,
              ...contextLines.slice(0, Math.max(0, height - 3 - feedback.length)),
              hint,
              ...inputLines,
              ...feedback,
            ];
  return framedFill(frame, rows, height, inner);
};

interface FleetRunLineState {
  readonly selected: boolean;
  readonly focused: boolean;
  readonly now: number;
  readonly duplicates: ReadonlySet<string>;
}

export const fleetRunLine = (
  theme: Theme,
  row: FleetTreeRow,
  state: FleetRunLineState,
  width: number,
): string => {
  const { run } = row;
  const { now, focused } = state;
  const selection = state.selected ? theme.fg(focused ? "accent" : "muted", ">") : " ";
  const branch = theme.fg("dim", runTreeBranch(row));
  const disclosure = row.hasChildren ? theme.fg("muted", row.expanded ? "▾" : "▸") : " ";
  const glyph = theme.fg(runStateColor(run.state), runStateGlyph(run.state, spinnerFrameAt(now)));
  const age =
    run.state === "completed"
      ? ` ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`
      : "";
  const details = `${runStateLabel(run.state)}${age} · ${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`;
  const identity = state.duplicates.has(run.name)
    ? `[${shortRunId(run.id)}] ${run.name}`
    : run.name;
  const label = focused
    ? focusedField(theme, sanitizeTerminalLine(`${identity} · ${details}`))
    : theme.fg(managerTone.identity, sanitizeTerminalLine(identity)) +
      theme.fg("muted", ` · ${sanitizeTerminalLine(details)}`);
  return padListDetailRow(`${selection} ${branch}${disclosure} ${glyph} ${label}`, width);
};

export const fleetListHeading = (
  rows: ReadonlyArray<FleetTreeRow>,
  visible: ReadonlyArray<{ readonly index: number }>,
): string => {
  if (rows.length === 0) return "Subagents";
  const start = (visible[0]?.index ?? 0) + 1;
  const end = (visible.at(-1)?.index ?? 0) + 1;
  return `Subagents · ${start}–${end} of ${rows.length}${start > 1 ? " · ↑ more" : ""}${end < rows.length ? " · ↓ more" : ""}`;
};

const fleetKeyLabel = (
  keybindingLabel: FleetKeybindingLabel | undefined,
  id: FullScreenSelectionKeybindingId,
  fallback: string,
): string => {
  const withoutTreeArrows = Fn.pipe(
    configuredKeyLabels(keybindingLabel, FLEET_SHORTCUTS).key(id, fallback),
    Str.split("/"),
    Arr.filter((label) => label !== "←" && label !== "→"),
    Arr.join("/"),
  );
  return withoutTreeArrows || fallback;
};

interface FleetHelpState {
  readonly prompting: boolean;
  readonly busyAction: string | undefined;
  readonly pending: PendingConfirmation | undefined;
  readonly alternateHelp: boolean;
  readonly listPane: boolean;
  readonly keybindingLabel: FleetKeybindingLabel | undefined;
}

const fleetNavigationHelp = (state: FleetHelpState, enter: string, escape: string) => {
  const keyLabel = (id: FullScreenSelectionKeybindingId, fallback: string) =>
    fleetKeyLabel(state.keybindingLabel, id, fallback);
  const configuredNavigation = state.keybindingLabel
    ? `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")}`
    : undefined;
  const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
  return state.listPane
    ? {
        primary: `${navigation} Move · h/l or ←/→ Collapse/expand · ${enter} Inspect`,
        scroll: "C-u/d Half-page · gg/G Ends",
        expandedScroll: "C-u/d Half · PgUp/PgDn Page · gg/G Ends",
        short: `${navigation} · h/l · ${enter}`,
        shortest: `${navigation} · h/l`,
      }
    : {
        primary: `j/k Scroll · h/${escape} Back`,
        scroll: "C-u/d Detail · gg/G",
        expandedScroll: "C-u/d · PgUp/PgDn Detail · gg/G",
        short: `j/k · h/${escape}`,
        shortest: `j/k · h/${escape}`,
      };
};

export const fleetHelpText = (
  width: number,
  selected: SubagentRunView | undefined,
  state: FleetHelpState,
): string => {
  const contentWidth = Math.max(0, width - 2);
  const enter = fleetKeyLabel(state.keybindingLabel, "tui.select.confirm", "Enter");
  const escape = fleetKeyLabel(state.keybindingLabel, "tui.select.cancel", "Esc");
  const modal: ReadonlyArray<ReadonlyArray<string>> | undefined = state.prompting
    ? [[`${enter} Submit`, `${escape} Cancel`]]
    : state.busyAction
      ? [[state.busyAction, `${escape}/q Close`]]
      : state.pending
        ? [
            [
              `${CONFIRMATION_KEYS[state.pending.action]} Confirm ${state.pending.action} ${sanitizeTerminalLine(selected?.name ?? "selected subagent")}`,
              `${escape}/q Cancel`,
            ],
          ]
        : undefined;
  if (modal) return renderResponsiveManagerFooter(contentWidth, modal);
  if (!selected) return renderResponsiveManagerFooter(contentWidth, [[`${escape}/q Close`]]);
  const { actions, compactActions } = fleetActionLabels(selected);
  const nav = fleetNavigationHelp(state, enter, escape);
  if (state.alternateHelp)
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${nav.primary} · ${nav.expandedScroll}`,
        compactActions ?? "No run actions",
        `t Technical · ? Back · ${escape}/q Close`,
      ],
      [nav.primary, compactActions ?? "No actions", `? Back · ${escape}/q`],
      [compactActions ?? "No actions", `? Back · ${escape}/q`],
    ]);
  return renderResponsiveManagerFooter(contentWidth, [
    [`${nav.primary} · ${nav.scroll}`, actions, `t Technical · ? More · ${escape}/q Close`],
    [nav.primary, compactActions, `? More · ${escape}/q`],
    width >= 60
      ? [nav.short, compactActions, `? · ${escape}/q`]
      : [nav.shortest, `${enter} Inspect`, `? More · ${escape}/q`],
  ]);
};
