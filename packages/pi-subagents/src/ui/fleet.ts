import type { Theme } from "@earendil-works/pi-coding-agent";
import { managerNoticeGlyph, renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import {
  Input,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import {
  confirmedReservedShortcut,
  detailWindowPositionLabel,
  listDetailMotionFromAction,
  padListDetailRow,
  stackedListHeight,
  wideListDetailGeometry,
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
import { formatRelativeAge, renderSubagentSessionOutput } from "./session-output.ts";
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

const FLEET_SHORTCUTS = new Set(["i", "m", "n", "r", "t", "x"]);
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

  constructor(options: FleetOptions) {
    this.options = options;
    this.frame = listDetailFrame(options.theme);
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

  private select(index: number, runs: ReadonlyArray<SubagentRunView>): void {
    this.applySelection(
      this.shell.select(
        index,
        runs.map((run) => run.id),
      ),
    );
  }

  private reconcile(runs: ReadonlyArray<SubagentRunView>): void {
    this.applySelection(this.shell.reconcile(runs.map((run) => run.id)));
    const selected = runs[this.shell.state.selected];
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
    const runs = this.options.getProjection().runs;
    this.reconcile(runs);
    const selected = runs[this.shell.state.selected];
    const matchesKeybinding = this.options.matchesKeybinding;

    if (this.prompt) {
      const resolution = this.shell.keymap.resolve(data, { mode: "text-input", matchesKeybinding });
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.prompt = undefined;
        this.notice = { kind: "info", text: "Input canceled." };
        this.options.requestRender();
      } else if (resolution?._tag === "Action" && resolution.action === "confirm")
        this.submitPrompt();
      else {
        this.prompt.feedback = undefined;
        this.prompt.input.handleInput(data);
        this.options.requestRender();
      }
      return;
    }

    if (this.pendingStop) {
      const resolution = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set(["x"]),
      });
      const run = selected && this.pendingStop === selected.id ? selected : undefined;
      this.pendingStop = undefined;
      if (confirmedReservedShortcut(resolution, data, "x") && run && canStop(run))
        this.performAction(
          `Stopping ${sanitizeTerminalLine(run.name)}…`,
          `Stopped ${sanitizeTerminalLine(run.name)}.`,
          () => this.options.actions.stop(run.id),
        );
      else {
        this.notice = { kind: "info", text: "Stop canceled." };
        this.options.requestRender();
      }
      return;
    }

    if (this.busyAction) {
      // Esc/q close the overlay so a hung action can never trap the user; the in-flight
      // operation itself is not cancelled and settles into the notice state on its own.
      const resolution = this.shell.keymap.resolve(data, { mode: "busy", matchesKeybinding });
      if (
        resolution?._tag === "Action" &&
        (resolution.action === "cancel" || resolution.action === "quit")
      )
        this.options.close();
      return;
    }

    // Every notice, including errors, dismisses on the next navigation key.
    this.notice = undefined;
    const resolution = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding,
      reservedKeys: FLEET_SHORTCUTS,
    });
    if (!resolution) return;

    if (resolution._tag === "Shortcut") {
      if (resolution.key === "t") {
        this.showTechnicalDetails = !this.showTechnicalDetails;
        this.shell.resetDetailScroll();
      } else if (resolution.key === "x" && selected && canStop(selected))
        this.pendingStop = selected.id;
      else if (resolution.key === "i" && selected && canInterrupt(selected))
        this.performAction(
          `Interrupting ${sanitizeTerminalLine(selected.name)}…`,
          `Interrupted ${sanitizeTerminalLine(selected.name)}; state is paused.`,
          () => this.options.actions.interrupt(selected.id),
        );
      else if (resolution.key === "r" && selected && canResume(selected))
        this.openPrompt(selected, "resume");
      else if (resolution.key === "m" && selected && canMessage(selected))
        this.openPrompt(
          selected,
          selected.state === "waiting_for_parent"
            ? "reply"
            : selected.state === "reported"
              ? "next-assignment"
              : "guidance",
        );
      else if (resolution.key === "n" && selected && canRename(selected))
        this.openPrompt(selected, "rename");
      else if (selected) {
        const reason =
          resolution.key === "m"
            ? "This run cannot receive guidance, a reply, or a new assignment in its current state."
            : resolution.key === "i"
              ? "This run cannot be interrupted in its current state or backend."
              : resolution.key === "r"
                ? "This run cannot be resumed in its current state or backend."
                : resolution.key === "n"
                  ? "This run cannot be renamed in its current state or backend."
                  : "This run is not currently stoppable.";
        this.notice = { kind: "info", text: reason };
      } else this.notice = { kind: "info", text: "No subagent run is selected." };
      this.options.requestRender();
      return;
    }

    if (resolution.action === "confirm") {
      // Enter policy stays local: every layout opens/toggles the detail pane on Enter.
      if (selected) this.shell.enterPane();
      this.options.requestRender();
      return;
    }
    if (resolution.action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(resolution.action);
    if (motion) {
      const result = this.shell.applyMotion(motion, {
        rowCount: runs.length,
        hasSelection: selected !== undefined,
      });
      if (result._tag === "Close") {
        this.options.close();
        return;
      }
      if (result._tag === "Update" && result.movedSelection)
        this.select(result.state.selected, runs);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.shell.syncLayout(safeWidth);
    const projection = this.options.getProjection();
    const runs = projection.runs;
    this.reconcile(runs);
    const selected = runs[this.shell.state.selected];
    this.shell.ensureSelectionPane(selected !== undefined);
    const working = runs.filter(
      (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
    ).length;
    const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
    const paused = runs.filter((run) => run.state === "paused").length;
    const retained = runs.filter((run) => run.state === "reported").length;
    const titleRaw = ` /subagents · ${runs.length} run${runs.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""}${retained ? ` · ${retained} retained` : ""} `;
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
            ? this.renderWide(safeWidth, contentHeight, runs, selected)
            : this.shell.state.layout === "stacked"
              ? this.renderStacked(safeWidth, contentHeight, runs, selected)
              : this.renderNarrow(safeWidth, contentHeight, runs, selected);
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
    const title =
      prompt.kind === "reply"
        ? `Reply to ${prompt.runName}`
        : prompt.kind === "next-assignment"
          ? `Next assignment for ${prompt.runName}`
          : prompt.kind === "guidance"
            ? `Guide ${prompt.runName}`
            : prompt.kind === "resume"
              ? `Resume ${prompt.runName}`
              : `Rename ${prompt.runName}`;
    const instruction =
      prompt.kind === "reply"
        ? "Answer the pending question"
        : prompt.kind === "next-assignment"
          ? "Describe the next assignment"
          : prompt.kind === "guidance"
            ? "Enter guidance for the active assignment"
            : prompt.kind === "resume"
              ? "Optional continuation message; submit blank to resume"
              : "Enter a new display name";
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
    run: SubagentRunView,
    index: number,
    width: number,
    runs: ReadonlyArray<SubagentRunView>,
  ): string {
    const selected = index === this.shell.state.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
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
    const duplicateName = runs.some(
      (candidate) => candidate.id !== run.id && candidate.name === run.name,
    );
    const shortId = run.id.length <= 14 ? run.id : `…${run.id.slice(-13)}`;
    const identity = duplicateName ? `[${shortId}] ${run.name}` : run.name;
    const label = sanitizeTerminalLine(
      `${identity} · ${state} · ${run.writeIntent}${run.fastMode ? " · ⚡ fast" : ""}`,
    );
    return padListDetailRow(
      `${prefix} ${glyph} ${selected ? this.options.theme.fg("accent", label) : label}`,
      width,
    );
  }

  private visibleRuns(runs: ReadonlyArray<SubagentRunView>, limit: number) {
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    const { start, end } = this.shell.visibleWindow(runs.length, limit);
    return runs.slice(start, end).map((run, offset) => ({ run, index: start + offset }));
  }

  private listHeading(
    runs: ReadonlyArray<SubagentRunView>,
    visible: ReadonlyArray<{ readonly index: number }>,
  ): string {
    if (runs.length === 0) return "Subagents · none";
    const start = (visible[0]?.index ?? 0) + 1;
    const end = (visible.at(-1)?.index ?? 0) + 1;
    return `Subagents · ${start}–${end} of ${runs.length}${start > 1 ? " · ↑ more" : ""}${end < runs.length ? " · ↓ more" : ""}`;
  }

  private helpText(width: number, selected: SubagentRunView | undefined): string {
    const contentWidth = Math.max(0, width - 2);
    const key = (id: FleetKeybindingId, fallback: string): string =>
      filterReservedKeyLabel(
        this.options.keybindingLabel?.(id, fallback) || fallback,
        FLEET_SHORTCUTS,
        fallback,
      );
    const configuredNavigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : undefined;
    const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
    const enter = key("tui.select.confirm", "Enter");
    const escape = key("tui.select.cancel", "Esc");
    if (this.prompt)
      return renderResponsiveManagerFooter(contentWidth, [[`${enter} Submit`, `${escape} Cancel`]]);
    if (this.busyAction)
      return renderResponsiveManagerFooter(contentWidth, [[this.busyAction, `${escape}/q Close`]]);
    if (this.pendingStop)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `x Confirm stop ${sanitizeTerminalLine(selected?.name ?? "selected subagent")}`,
          `${escape}/q Cancel`,
        ],
      ]);
    const messageAction = !canMessage(selected)
      ? undefined
      : selected?.state === "waiting_for_parent"
        ? "m Reply"
        : selected?.state === "reported"
          ? "m New task"
          : "m Guide";
    if (!selected)
      // No alternate help exists without a selected run, so no "? More" hint is offered.
      return renderResponsiveManagerFooter(contentWidth, [["No runs", `${escape}/q Close`]]);
    const availableActions = [
      messageAction ? { full: messageAction, compact: messageAction } : undefined,
      canInterrupt(selected) ? { full: "i Interrupt", compact: "i Int" } : undefined,
      canResume(selected) ? { full: "r Resume", compact: "r Resume" } : undefined,
      canRename(selected) ? { full: "n Rename", compact: "n Name" } : undefined,
      canStop(selected) ? { full: "x Stop", compact: "x Stop" } : undefined,
    ].filter((item): item is { full: string; compact: string } => item !== undefined);
    const actions = availableActions.map((item) => item.full);
    const compactActions = availableActions.map((item) => item.compact);
    const scrollHelp =
      this.shell.state.pane === "list" ? "C-u/d Half-page · gg/G Ends" : "C-u/d Detail · gg/G";
    // The expanded ? overlay is the discoverable place for the full motion vocabulary.
    const expandedScrollHelp =
      this.shell.state.pane === "list"
        ? "C-u/d Half · PgUp/PgDn Page · gg/G Ends"
        : "C-u/d · PgUp/PgDn Detail · gg/G";
    if (this.alternateHelp)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `${navigation} Move · h/l Panes · ${expandedScrollHelp}`,
          compactActions.length > 0 ? compactActions.join(" · ") : "No run actions",
          `t Technical · ? Back · ${escape}/q Close`,
        ],
        [
          `${navigation} · h/l · ${expandedScrollHelp}`,
          compactActions.length > 0 ? compactActions.join(" · ") : "No actions",
          `? Back · ${escape}/q`,
        ],
        [
          compactActions.length > 0 ? compactActions.join(" · ") : "No actions",
          `? Back · ${escape}/q`,
        ],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Move · h/l Panes · ${scrollHelp}`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        `t Technical · ? More · ${escape}/q Close`,
      ],
      [
        `${navigation} · h/l · ${scrollHelp}`,
        compactActions.length > 0 ? compactActions.join(" · ") : undefined,
        `? More · ${escape}/q`,
      ],
      width >= 60
        ? [
            `${navigation} · h/l · gg/G`,
            compactActions.length > 0 ? compactActions.join(" · ") : undefined,
            `? · ${escape}/q`,
          ]
        : [`${navigation} · h/l`, "gg/G", `? More · ${escape}/q`],
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
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const { listWidth, detailWidth } = wideListDetailGeometry(width, 38, 0.42);
    const visible = this.visibleRuns(runs, Math.max(1, height - 1));
    const focused = this.shell.state.pane === "list";
    const left = [
      this.options.theme.fg(
        focused ? "accent" : "muted",
        `${focused ? "› " : ""}${this.listHeading(runs, visible)}`,
      ),
      ...visible.map(({ run, index }) => this.runLine(run, index, listWidth, runs)),
    ];
    const right = this.detailWindow(this.detailLines(selected, detailWidth), height, detailWidth);
    return framedWideRows(this.frame, { left, right, height, listWidth, detailWidth });
  }

  private renderStacked(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = stackedListHeight(height, runs.length);
    const visible = this.visibleRuns(runs, listHeight - 1);
    const focused = this.shell.state.pane === "list";
    const list = [
      this.options.theme.fg(
        focused ? "accent" : "muted",
        `${focused ? "› " : ""}${this.listHeading(runs, visible)}`,
      ),
      ...visible.map(({ run, index }) => this.runLine(run, index, inner, runs)),
    ];
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    return framedStackedRows(this.frame, { list, detail, height, inner });
  }

  private renderNarrow(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.shell.state.details && selected
        ? this.detailWindow(this.detailLines(selected, inner), height, inner)
        : runs.length
          ? (() => {
              const visible = this.visibleRuns(runs, Math.max(1, height - 1));
              if (height <= 1)
                return visible.map(({ run, index }) => this.runLine(run, index, inner, runs));
              return [
                this.options.theme.fg("accent", this.listHeading(runs, visible)),
                ...visible.map(({ run, index }) => this.runLine(run, index, inner, runs)),
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
