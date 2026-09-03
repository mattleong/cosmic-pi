import type { Theme } from "@earendil-works/pi-coding-agent";
import { managerNoticeGlyph, renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import {
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import type {
  FullScreenAction,
  FullScreenMode,
  FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keymap";
import {
  confirmedReservedShortcut,
  detailWindowPositionLabel,
  listDetailMotionFromAction,
  padListDetailRow,
  stackedListHeight,
  wideListDetailGeometry,
  type ListDetailPane,
  type ListSelectionChange,
} from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedRow,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  ListDetailShell,
  type ListDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import {
  hasSubagentCapability,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import { formatRelativeAge } from "./metrics.ts";
import { projectFleetTree, runTreeBranch, type FleetTreeRow } from "./run-tree-rows.ts";
import { renderSubagentSessionOutput } from "./session-output.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";

export type FleetMessageMode = "guidance" | "reply" | "next-assignment";

export interface FleetActions {
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly message: (id: string, mode: FleetMessageMode, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
}

export type FleetKeybindingId = FullScreenSelectionKeybindingId;

export interface FleetOptions {
  readonly theme: Theme;
  readonly getProjection: () => SubagentProjection;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly matchesKeybinding?: ((data: string, id: FleetKeybindingId) => boolean) | undefined;
  readonly keybindingLabel?: ((id: FleetKeybindingId, fallback: string) => string) | undefined;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly actions: FleetActions;
  /** Nested Pi cannot navigate above this authenticated run. Root uses the virtual root node. */
  readonly visibilityRootId?: string | undefined;
}

const canMessage = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    ((run.state === "reported" && run.closeOnReport === false) ||
      (run.state === "running" && hasSubagentCapability(run, "steer")) ||
      (run.state === "waiting_for_parent" && hasSubagentCapability(run, "parent-contact"))),
  );
const canInterrupt = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "interrupt") &&
    (run.state === "running" || run.state === "waiting_for_parent"),
  );
const canResume = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "resume") &&
    (run.state === "paused" || run.state === "completed"),
  );
const canRename = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "rename-display") &&
    run.state !== "starting" &&
    run.state !== "stopping" &&
    run.state !== "stopped" &&
    run.state !== "failed",
  );
const canStop = (run: SubagentRunView | undefined): boolean =>
  Boolean(run && isActiveRunState(run.state) && run.state !== "stopping");

type FleetPromptKind = "guidance" | "reply" | "next-assignment" | "resume" | "rename";

const FLEET_SHORTCUTS = new Set(["h", "i", "l", "m", "n", "r", "t", "x"]);

const shortcutUnavailableReason = (key: string): string =>
  key === "m"
    ? "This run cannot receive guidance, a reply, or a new assignment in its current state."
    : key === "i"
      ? "This run cannot be interrupted in its current state or backend."
      : key === "r"
        ? "This run cannot be resumed in its current state or backend."
        : key === "n"
          ? "This run cannot be renamed in its current state or backend."
          : "This run is not currently stoppable.";

/** Fixed list-pane tree keys resolve before the configurable navigation keymap. */
const fixedTreeDirection = (data: string, pane: ListDetailPane): "back" | "forward" | undefined =>
  pane === "list"
    ? matchesKey(data, "h") || matchesKey(data, Key.left)
      ? "back"
      : matchesKey(data, "l") || matchesKey(data, Key.right)
        ? "forward"
        : undefined
    : undefined;

interface FleetActionLabel {
  readonly full: string;
  readonly compact: string;
}

const FLEET_ACTION_LABELS = [
  [canInterrupt, "i Interrupt", "i Int"],
  [canResume, "r Resume", "r Resume"],
  [canRename, "n Rename", "n Name"],
  [canStop, "x Stop subtree", "x Stop tree"],
] as const;

const fleetActionLabels = (selected: SubagentRunView): ReadonlyArray<FleetActionLabel> => {
  const labels: FleetActionLabel[] = [];
  if (canMessage(selected)) {
    const messageLabel =
      selected.state === "waiting_for_parent"
        ? "m Reply"
        : selected.state === "reported"
          ? "m New task"
          : "m Guide";
    labels.push({ full: messageLabel, compact: messageLabel });
  }
  for (const [can, full, compact] of FLEET_ACTION_LABELS)
    if (can(selected)) labels.push({ full, compact });
  return labels;
};

const PROMPT_TITLE_PREFIX = {
  reply: "Reply to",
  "next-assignment": "Next assignment for",
  guidance: "Guide",
  resume: "Resume",
  rename: "Rename",
} as const satisfies Record<FleetPromptKind, string>;

const PROMPT_INSTRUCTIONS = {
  reply: "Answer the pending question",
  "next-assignment": "Describe the next assignment",
  guidance: "Enter guidance for the active assignment",
  resume: "Optional continuation message; submit blank to resume",
  rename: "Enter a new display name",
} as const satisfies Record<FleetPromptKind, string>;

const promptTitle = (prompt: FleetPrompt): string =>
  `${PROMPT_TITLE_PREFIX[prompt.kind]} ${prompt.runName}`;

const promptInstruction = (kind: FleetPromptKind): string => PROMPT_INSTRUCTIONS[kind];
type FleetNotice = { readonly kind: "info" | "success" | "error"; readonly text: string };
type FleetPrompt = {
  readonly kind: FleetPromptKind;
  readonly runId: string;
  readonly runName: string;
  readonly input: Input;
  readonly context?: string | undefined;
  feedback?: string | undefined;
};

export class SubagentFleetComponent implements Component, Focusable {
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pendingStop: string | undefined;
  private prompt: FleetPrompt | undefined;
  private notice: FleetNotice | undefined;
  private busyAction: string | undefined;
  private _focused = false;
  private readonly shell = new ListDetailShell();
  private readonly frame: ListDetailFrame;
  private readonly options: FleetOptions;
  private readonly collapsedRunIds = new Set<string>();

  constructor(options: FleetOptions) {
    this.options = options;
    this.frame = listDetailFrame(options.theme);
  }

  private tree(projection: SubagentProjection) {
    return projectFleetTree(
      projection.runs,
      this.options.visibilityRootId ?? "root",
      this.collapsedRunIds,
    );
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.prompt) this.prompt.input.focused = value;
  }

  private applySelection(next: ListSelectionChange): void {
    if (next.changed) this.pendingStop = undefined;
  }

  /** Shared keymap resolution bound to this overlay's configurable keybindings. */
  private resolveInput(data: string, mode: FullScreenMode, reservedKeys?: ReadonlySet<string>) {
    return this.shell.keymap.resolve(data, {
      mode,
      matchesKeybinding: this.options.matchesKeybinding,
      ...(reservedKeys && { reservedKeys }),
    });
  }

  private select(index: number, rows: ReadonlyArray<FleetTreeRow>): void {
    this.applySelection(
      this.shell.select(
        index,
        rows.map((row) => row.run.id),
      ),
    );
  }

  private reconcile(rows: ReadonlyArray<FleetTreeRow>): void {
    this.applySelection(this.shell.reconcile(rows.map((row) => row.run.id)));
    const selected = rows[this.shell.state.selected]?.run;
    if (this.pendingStop && (this.pendingStop !== selected?.id || !canStop(selected)))
      this.pendingStop = undefined;
    if (this.prompt && this.prompt.runId !== selected?.id) this.prompt = undefined;
  }

  private openPrompt(run: SubagentRunView, kind: FleetPromptKind): void {
    const input = new Input();
    input.focused = this._focused;
    const question = kind === "reply" ? run.question?.message : undefined;
    this.prompt = {
      kind,
      runId: run.id,
      runName: sanitizeTerminalLine(run.name),
      input,
      ...(question && { context: sanitizeTerminalLine(question) }),
    };
    this.notice = undefined;
  }

  private performAction(progress: string, success: string, operation: () => Promise<void>): void {
    this.busyAction = progress;
    this.notice = { kind: "info", text: progress };
    this.options.requestRender();
    let result: Promise<void>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result).then(
      () => {
        this.busyAction = undefined;
        this.notice = { kind: "success", text: success };
        this.options.requestRender();
      },
      (error) => {
        this.busyAction = undefined;
        this.notice = {
          kind: "error",
          text: error instanceof Error ? error.message : "Subagent operation failed.",
        };
        this.options.requestRender();
      },
    );
  }

  private submitPrompt(): void {
    const prompt = this.prompt;
    if (!prompt) return;
    const message = prompt.input.getValue().trim();
    if (prompt.kind !== "resume" && !message) {
      prompt.feedback = prompt.kind === "rename" ? "Enter a new display name." : "Enter a message.";
      this.options.requestRender();
      return;
    }
    this.prompt = undefined;
    const name = prompt.runName;
    if (prompt.kind === "resume") {
      this.performAction(`Resuming ${name}…`, `Resumed ${name}.`, () =>
        this.options.actions.resume(prompt.runId, message || undefined),
      );
      return;
    }
    if (prompt.kind === "rename") {
      this.performAction(
        `Renaming ${name}…`,
        `Renamed ${name} to ${sanitizeTerminalLine(message)}.`,
        () => this.options.actions.rename(prompt.runId, message),
      );
      return;
    }
    const mode: FleetMessageMode = prompt.kind;
    const verb =
      mode === "reply"
        ? "Sending reply"
        : mode === "next-assignment"
          ? "Starting next assignment"
          : "Sending guidance";
    const success =
      mode === "reply"
        ? `Reply sent to ${name}.`
        : mode === "next-assignment"
          ? `Next assignment sent to ${name}.`
          : `Guidance sent to ${name}.`;
    this.performAction(`${verb}…`, success, () =>
      this.options.actions.message(prompt.runId, mode, message),
    );
  }

  handleInput(data: string): void {
    const projection = this.options.getProjection();
    const rows = this.tree(projection).rows;
    this.reconcile(rows);
    const selectedRow = rows[this.shell.state.selected];
    const selected = selectedRow?.run;

    if (this.prompt) return this.handlePromptInput(data, this.prompt);
    if (this.pendingStop) return this.handlePendingStopInput(data, selected);
    if (this.busyAction) return this.handleBusyInput(data);

    // Every notice, including errors, dismisses on the next navigation key.
    this.notice = undefined;
    if (this.handleFixedTreeInput(data, projection, selectedRow)) return;
    const resolution = this.resolveInput(data, "navigation", FLEET_SHORTCUTS);
    if (!resolution) return;
    if (resolution._tag === "Shortcut") this.handleShortcut(resolution.key, selected);
    else this.handleNavigation(resolution.action, rows, selected);
  }

  private handlePromptInput(data: string, prompt: FleetPrompt): void {
    const resolution = this.resolveInput(data, "text-input");
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.prompt = undefined;
      this.notice = { kind: "info", text: "Input canceled." };
      this.options.requestRender();
    } else if (resolution?._tag === "Action" && resolution.action === "confirm")
      this.submitPrompt();
    else {
      prompt.feedback = undefined;
      prompt.input.handleInput(data);
      this.options.requestRender();
    }
  }

  private handlePendingStopInput(data: string, selected: SubagentRunView | undefined): void {
    const resolution = this.resolveInput(data, "confirmation", new Set(["x"]));
    const run = selected && this.pendingStop === selected.id ? selected : undefined;
    this.pendingStop = undefined;
    if (confirmedReservedShortcut(resolution, data, "x") && run && canStop(run))
      this.performAction(
        `Stopping subtree at ${sanitizeTerminalLine(run.name)}…`,
        `Stopped subtree at ${sanitizeTerminalLine(run.name)}.`,
        () => this.options.actions.stop(run.id),
      );
    else {
      this.notice = { kind: "info", text: "Stop canceled." };
      this.options.requestRender();
    }
  }

  private handleBusyInput(data: string): void {
    // Esc/q close the overlay so a hung action can never trap the user; the in-flight
    // operation itself is not cancelled and settles into the notice state on its own.
    const resolution = this.resolveInput(data, "busy");
    if (
      resolution?._tag === "Action" &&
      (resolution.action === "cancel" || resolution.action === "quit")
    )
      this.options.close();
  }

  /** Collapses or expands the selected subtree; returns false when `data` is not a tree key. */
  private handleFixedTreeInput(
    data: string,
    projection: SubagentProjection,
    selectedRow: FleetTreeRow | undefined,
  ): boolean {
    const direction = fixedTreeDirection(data, this.shell.state.pane);
    if (!direction) return false;
    if (selectedRow?.hasChildren) {
      if (direction === "back") this.collapsedRunIds.add(selectedRow.run.id);
      else this.collapsedRunIds.delete(selectedRow.run.id);
      this.shell.resetDetailScroll();
      this.reconcile(this.tree(projection).rows);
    }
    this.options.requestRender();
    return true;
  }

  private handleShortcut(key: string, selected: SubagentRunView | undefined): void {
    if (key === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.shell.resetDetailScroll();
    } else if (!selected) this.notice = { kind: "info", text: "No subagent run is selected." };
    else if (!this.applyRunShortcut(key, selected))
      this.notice = { kind: "info", text: shortcutUnavailableReason(key) };
    this.options.requestRender();
  }

  /** Applies one run shortcut; returns false when it does not apply to the run's state or backend. */
  private applyRunShortcut(key: string, selected: SubagentRunView): boolean {
    if (key === "x" && canStop(selected)) this.pendingStop = selected.id;
    else if (key === "i" && canInterrupt(selected))
      this.performAction(
        `Interrupting ${sanitizeTerminalLine(selected.name)}…`,
        `Interrupted ${sanitizeTerminalLine(selected.name)}; state is paused.`,
        () => this.options.actions.interrupt(selected.id),
      );
    else if (key === "r" && canResume(selected)) this.openPrompt(selected, "resume");
    else if (key === "m" && canMessage(selected))
      this.openPrompt(
        selected,
        selected.state === "waiting_for_parent"
          ? "reply"
          : selected.state === "reported"
            ? "next-assignment"
            : "guidance",
      );
    else if (key === "n" && canRename(selected)) this.openPrompt(selected, "rename");
    else return false;
    return true;
  }

  private handleNavigation(
    action: FullScreenAction,
    rows: ReadonlyArray<FleetTreeRow>,
    selected: SubagentRunView | undefined,
  ): void {
    if (action === "confirm") {
      if (selected) this.shell.enterPane();
      this.options.requestRender();
      return;
    }
    if (action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(action);
    if (motion) {
      const result = this.shell.applyMotion(motion, {
        rowCount: rows.length,
        hasSelection: selected !== undefined,
      });
      if (result._tag === "Close") {
        this.options.close();
        return;
      }
      if (result._tag === "Update" && result.movedSelection)
        this.select(result.state.selected, rows);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.shell.syncLayout(safeWidth);
    const projection = this.options.getProjection();
    const tree = this.tree(projection);
    const rows = tree.rows;
    this.reconcile(rows);
    const selected = rows[this.shell.state.selected]?.run;
    this.shell.ensureSelectionPane(selected !== undefined);
    const working = tree.runs.filter(
      (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
    ).length;
    const waiting = tree.runs.filter((run) => run.state === "waiting_for_parent").length;
    const paused = tree.runs.filter((run) => run.state === "paused").length;
    const retained = tree.runs.filter((run) => run.state === "reported").length;
    const hidden = tree.runs.length - rows.length;
    const titleRaw = ` /subagents · ${tree.runs.length} run${tree.runs.length === 1 ? "" : "s"}${hidden ? ` · ${rows.length} visible` : ""}${working ? ` · ${working} working` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""}${retained ? ` · ${retained} retained` : ""} `;
    const title = truncateToWidth(titleRaw, Math.max(0, safeWidth - 2), "");
    const help = this.helpText(safeWidth, selected);
    const safeHelp = truncateToWidth(help, Math.max(0, safeWidth - 2), "");
    return framedScreen(this.frame, {
      width: safeWidth,
      height,
      top: this.options.theme.fg("accent", title),
      bottom: safeHelp,
      body: (bodyHeight) => {
        if (this.prompt) return this.renderPrompt(safeWidth, bodyHeight, this.prompt);
        const showNotice = this.notice !== undefined && bodyHeight > 0;
        const contentHeight = Math.max(0, bodyHeight - (showNotice ? 1 : 0));
        const content =
          this.shell.state.layout === "wide"
            ? this.renderWide(safeWidth, contentHeight, rows, tree.runs, selected)
            : this.shell.state.layout === "stacked"
              ? this.renderStacked(safeWidth, contentHeight, rows, tree.runs, selected)
              : this.renderNarrow(safeWidth, contentHeight, rows, tree.runs, selected);
        return showNotice ? [this.renderNotice(safeWidth, this.notice!), ...content] : content;
      },
    });
  }

  private renderNotice(width: number, notice: FleetNotice): string {
    const inner = Math.max(0, width - 2);
    const glyph = managerNoticeGlyph(notice.kind);
    const color =
      notice.kind === "error" ? "error" : notice.kind === "success" ? "success" : "muted";
    return framedRow(
      this.frame,
      this.options.theme.fg(color, `${glyph} ${sanitizeTerminalLine(notice.text)}`),
      inner,
    );
  }

  private renderPrompt(width: number, height: number, prompt: FleetPrompt): string[] {
    const inner = Math.max(0, width - 2);
    const title = promptTitle(prompt);
    const instruction = promptInstruction(prompt.kind);
    const inputLines = prompt.input.render(Math.max(1, inner)).slice(0, 1);
    const feedback = prompt.feedback ? [this.options.theme.fg("warning", prompt.feedback)] : [];
    const contextLines = prompt.context
      ? wrapTextWithAnsi(
          this.options.theme.fg("warning", `Question: ${prompt.context}`),
          Math.max(1, inner),
        )
      : [];
    const rows =
      height <= 1
        ? inputLines
        : height === 2
          ? [
              ...inputLines,
              ...(feedback.length > 0 ? feedback : [this.options.theme.fg("dim", instruction)]),
            ]
          : height === 3 && feedback.length > 0
            ? [
                this.options.theme.fg("accent", this.options.theme.bold(title)),
                ...inputLines,
                ...feedback,
              ]
            : [
                this.options.theme.fg("accent", this.options.theme.bold(title)),
                ...contextLines.slice(0, Math.max(0, height - 3 - feedback.length)),
                this.options.theme.fg("dim", instruction),
                ...inputLines,
                ...feedback,
              ];
    return framedFill(this.frame, rows, height, inner);
  }

  private runLine(
    row: FleetTreeRow,
    index: number,
    width: number,
    scopeRuns: ReadonlyArray<SubagentRunView>,
  ): string {
    const { run } = row;
    const selected = index === this.shell.state.selected;
    const selection = selected ? this.options.theme.fg("accent", ">") : " ";
    const branch = this.options.theme.fg("dim", runTreeBranch(row));
    const disclosure = row.hasChildren
      ? this.options.theme.fg("muted", row.expanded ? "▾" : "▸")
      : " ";
    const frame = Math.floor(this.options.getNow() / 160);
    const glyph = this.options.theme.fg(
      runStateColor(run.state),
      animatedRunStateGlyph(run.state, frame),
    );
    const state =
      run.state === "completed"
        ? `finished ${formatRelativeAge(this.options.getNow() - (run.endedAt ?? run.lastActivityAt))}`
        : run.state === "reported"
          ? `report ${run.reportGeneration} · retained`
          : runStateLabel(run.state);
    const duplicateName = scopeRuns.some(
      (candidate) => candidate.id !== run.id && candidate.name === run.name,
    );
    const shortId = run.id.length <= 14 ? run.id : `…${run.id.slice(-13)}`;
    const identity = duplicateName ? `[${shortId}] ${run.name}` : run.name;
    const label = sanitizeTerminalLine(
      `${identity} · ${state} · ${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`,
    );
    return padListDetailRow(
      `${selection} ${branch}${disclosure} ${glyph} ${
        selected ? this.options.theme.fg("accent", label) : label
      }`,
      width,
    );
  }

  private visibleRows(rows: ReadonlyArray<FleetTreeRow>, limit: number) {
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    const { start, end } = this.shell.visibleWindow(rows.length, limit);
    return rows.slice(start, end).map((row, offset) => ({ row, index: start + offset }));
  }

  private listHeading(
    rows: ReadonlyArray<FleetTreeRow>,
    visible: ReadonlyArray<{ readonly index: number }>,
  ): string {
    if (rows.length === 0) return "Subagents · none";
    const start = (visible[0]?.index ?? 0) + 1;
    const end = (visible.at(-1)?.index ?? 0) + 1;
    return `Subagents · ${start}–${end} of ${rows.length}${start > 1 ? " · ↑ more" : ""}${end < rows.length ? " · ↓ more" : ""}`;
  }

  private keyLabel(id: FleetKeybindingId, fallback: string): string {
    const printableFiltered = filterReservedKeyLabel(
      this.options.keybindingLabel?.(id, fallback) || fallback,
      FLEET_SHORTCUTS,
      fallback,
    );
    const withoutTreeArrows = printableFiltered
      .split("/")
      .filter((label) => label !== "←" && label !== "→")
      .join("/");
    return withoutTreeArrows || fallback;
  }

  private helpText(width: number, selected: SubagentRunView | undefined): string {
    const contentWidth = Math.max(0, width - 2);
    const enter = this.keyLabel("tui.select.confirm", "Enter");
    const escape = this.keyLabel("tui.select.cancel", "Esc");
    // Footer rows while a prompt, action, or stop confirmation owns the input.
    const modal: ReadonlyArray<ReadonlyArray<string>> | undefined = this.prompt
      ? [[`${enter} Submit`, `${escape} Cancel`]]
      : this.busyAction
        ? [[this.busyAction, `${escape}/q Close`]]
        : this.pendingStop
          ? [
              [
                `x Confirm stop ${sanitizeTerminalLine(selected?.name ?? "selected subagent")}`,
                `${escape}/q Cancel`,
              ],
            ]
          : undefined;
    if (modal) return renderResponsiveManagerFooter(contentWidth, modal);
    if (!selected)
      return renderResponsiveManagerFooter(contentWidth, [
        ["No visible subagents", `${escape}/q Close`],
      ]);
    const available = fleetActionLabels(selected);
    const actions =
      available.length > 0 ? available.map((item) => item.full).join(" · ") : undefined;
    const compactActions =
      available.length > 0 ? available.map((item) => item.compact).join(" · ") : undefined;
    const configuredNavigation = this.options.keybindingLabel
      ? `${this.keyLabel("tui.select.up", "↑")}/${this.keyLabel("tui.select.down", "↓")}`
      : undefined;
    const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
    // The expanded ? overlay is the discoverable place for the full motion vocabulary.
    const listPane = this.shell.state.pane === "list";
    const nav = listPane
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
    if (this.alternateHelp)
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
  }

  private detailLines(run: SubagentRunView | undefined, width: number): string[] {
    if (!run) return [this.options.theme.fg("dim", "No subagents in this parent session.")];
    return renderSubagentSessionOutput(run, this.options.theme, {
      now: this.options.getNow(),
      showTechnicalDetails: this.showTechnicalDetails,
    }).render(Math.max(1, width));
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    // No follow policy: scroll 0 keeps tracking the newest lines (tri-state `undefined`).
    const window = this.shell.detailWindow(lines, height);
    if (!window.overflow) return [...window.visible];
    const position = this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow));
    return [padListDetailRow(position, width), ...window.visible];
  }

  private renderWide(
    width: number,
    height: number,
    rows: ReadonlyArray<FleetTreeRow>,
    scopeRuns: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const { listWidth, detailWidth } = wideListDetailGeometry(width, 38, 0.42);
    const visible = this.visibleRows(rows, Math.max(1, height - 1));
    const focused = this.shell.state.pane === "list";
    const left = [
      this.options.theme.fg(
        focused ? "accent" : "muted",
        `${focused ? "› " : ""}${this.listHeading(rows, visible)}`,
      ),
      ...visible.map(({ row, index }) => this.runLine(row, index, listWidth, scopeRuns)),
    ];
    const right = this.detailWindow(this.detailLines(selected, detailWidth), height, detailWidth);
    return framedWideRows(this.frame, { left, right, height, listWidth, detailWidth });
  }

  private renderStacked(
    width: number,
    height: number,
    rows: ReadonlyArray<FleetTreeRow>,
    scopeRuns: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = stackedListHeight(height, rows.length);
    const visible = this.visibleRows(rows, listHeight - 1);
    const focused = this.shell.state.pane === "list";
    const list = [
      this.options.theme.fg(
        focused ? "accent" : "muted",
        `${focused ? "› " : ""}${this.listHeading(rows, visible)}`,
      ),
      ...visible.map(({ row, index }) => this.runLine(row, index, inner, scopeRuns)),
    ];
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    return framedStackedRows(this.frame, { list, detail, height, inner });
  }

  private renderNarrow(
    width: number,
    height: number,
    rows: ReadonlyArray<FleetTreeRow>,
    scopeRuns: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.shell.state.details && selected
        ? this.detailWindow(this.detailLines(selected, inner), height, inner)
        : rows.length
          ? (() => {
              const visible = this.visibleRows(rows, Math.max(1, height - 1));
              if (height <= 1)
                return visible.map(({ row, index }) => this.runLine(row, index, inner, scopeRuns));
              return [
                this.options.theme.fg("accent", this.listHeading(rows, visible)),
                ...visible.map(({ row, index }) => this.runLine(row, index, inner, scopeRuns)),
              ];
            })()
          : [
              this.options.theme.fg(
                "dim",
                "No subagents. Ask the agent to start one with subagent_start.",
              ),
            ];
    if (!this.shell.state.details) this.shell.resetDetailWindow();
    return framedFill(this.frame, lines, height, inner);
  }

  invalidate(): void {
    this.prompt?.input.invalidate();
  }
}
