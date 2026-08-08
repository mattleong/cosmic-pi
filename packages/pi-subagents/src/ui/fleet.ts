import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  managerLayoutTier,
  managerNoticeGlyph,
  renderResponsiveManagerFooter,
} from "pi-cosmic-ui/manager";
import {
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import {
  FullScreenKeymap,
  pageSteps,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keymap";
import {
  computeDetailWindow,
  confirmedReservedShortcut,
  detailWindowPositionLabel,
  listDetailMotion,
  listDetailMotionFromAction,
  listWindowStart,
  padListDetailRow,
  reconcileListSelection,
  selectListIndex,
  stackedListHeight,
  wideListDetailGeometry,
  type ListDetailPane,
} from "pi-cosmic-ui/manager/list-detail";
import {
  hasSubagentCapability,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import { formatRelativeAge, renderSubagentSessionOutput } from "./session-output.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";
import { sanitizeTerminalLine } from "./sanitize.ts";

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

type FleetLayout = "wide" | "stacked" | "narrow";
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
  private selected = 0;
  private selectedId: string | undefined;
  private details = false;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private listPageSize = 1;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pendingStop: string | undefined;
  private prompt: FleetPrompt | undefined;
  private notice: FleetNotice | undefined;
  private busyAction: string | undefined;
  private layout: FleetLayout = "narrow";
  private pane: ListDetailPane = "list";
  private _focused = false;
  private readonly keymap = new FullScreenKeymap();
  private readonly options: FleetOptions;

  constructor(options: FleetOptions) {
    this.options = options;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.prompt) this.prompt.input.focused = value;
  }

  private applySelection(next: ReturnType<typeof selectListIndex>): void {
    this.selected = next.selected;
    this.selectedId = next.selectedId;
    if (next.changed) {
      this.detailScroll = 0;
      this.pendingStop = undefined;
    }
  }

  private select(index: number, runs: ReadonlyArray<SubagentRunView>): void {
    this.applySelection(
      selectListIndex(
        { selected: this.selected, selectedId: this.selectedId },
        index,
        runs.map((run) => run.id),
      ),
    );
  }

  private reconcile(runs: ReadonlyArray<SubagentRunView>): void {
    this.applySelection(
      reconcileListSelection(
        { selected: this.selected, selectedId: this.selectedId },
        runs.map((run) => run.id),
      ),
    );
    const selected = runs[this.selected];
    if (this.pendingStop && (this.pendingStop !== selected?.id || !canStop(selected)))
      this.pendingStop = undefined;
    if (this.prompt && this.prompt.runId !== selected?.id) this.prompt = undefined;
  }

  private openPrompt(run: SubagentRunView, kind: FleetPromptKind): void {
    const input = new Input();
    input.focused = this._focused;
    this.prompt = {
      kind,
      runId: run.id,
      runName: sanitizeTerminalLine(run.name),
      input,
      ...(kind === "reply" && run.question?.message
        ? { context: sanitizeTerminalLine(run.question.message) }
        : {}),
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
      (error: unknown) => {
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
    const selected = runs[this.selected];
    const matchesKeybinding = this.options.matchesKeybinding;

    if (this.prompt) {
      const resolution = this.keymap.resolve(data, { mode: "text-input", matchesKeybinding });
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
      const resolution = this.keymap.resolve(data, {
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
      const resolution = this.keymap.resolve(data, { mode: "busy", matchesKeybinding });
      if (
        resolution?._tag === "Action" &&
        (resolution.action === "cancel" || resolution.action === "quit")
      )
        this.options.close();
      return;
    }

    // Every notice, including errors, dismisses on the next navigation key.
    this.notice = undefined;
    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding,
      reservedKeys: FLEET_SHORTCUTS,
    });
    if (!resolution) return;

    if (resolution._tag === "Shortcut") {
      if (resolution.key === "t") {
        this.showTechnicalDetails = !this.showTechnicalDetails;
        this.detailScroll = 0;
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
      if (selected) {
        if (this.layout === "narrow") this.details = !this.details;
        this.pane = this.layout === "narrow" && !this.details ? "list" : "detail";
        this.detailScroll = 0;
        this.keymap.resetChord();
      }
      this.options.requestRender();
      return;
    }
    if (resolution.action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(resolution.action);
    if (motion) {
      const result = listDetailMotion(
        {
          pane: this.pane,
          details: this.details,
          selected: this.selected,
          detailScroll: this.detailScroll,
        },
        motion,
        {
          layout: this.layout,
          rowCount: runs.length,
          hasSelection: selected !== undefined,
          detailMaxScroll: this.detailMaxScroll,
          detailSteps: pageSteps(this.detailPageSize),
          listSteps: pageSteps(this.listPageSize),
        },
      );
      if (result._tag === "Close") {
        this.options.close();
        return;
      }
      if (result._tag === "Update") {
        this.pane = result.state.pane;
        this.details = result.state.details;
        this.detailScroll = result.state.detailScroll;
        if (result.movedSelection) this.select(result.state.selected, runs);
        if (result.resetChord) this.keymap.resetChord();
      }
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    const nextLayout = managerLayoutTier(safeWidth);
    if (nextLayout !== this.layout) {
      this.layout = nextLayout;
      this.keymap.resetChord();
      if (this.layout === "narrow") this.details = this.pane === "detail";
    }
    const projection = this.options.getProjection();
    const runs = projection.runs;
    this.reconcile(runs);
    const selected = runs[this.selected];
    if (!selected && this.pane === "detail") {
      this.pane = "list";
      this.details = false;
      this.keymap.resetChord();
    }
    const working = runs.filter(
      (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
    ).length;
    const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
    const paused = runs.filter((run) => run.state === "paused").length;
    const retained = runs.filter((run) => run.state === "reported").length;
    const titleRaw = ` /subagents · ${runs.length} run${runs.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""}${retained ? ` · ${retained} retained` : ""} `;
    const title = truncateToWidth(titleRaw, Math.max(0, safeWidth - 2), "");
    const top = `${this.outerBorder("╭")}${this.options.theme.fg("accent", title)}${this.outerBorder(
      `${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`,
    )}`;
    const help = this.helpText(safeWidth, selected);
    const safeHelp = truncateToWidth(help, Math.max(0, safeWidth - 2), "");
    const bottom = `${this.outerBorder(
      `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(safeHelp) - 2))}`,
    )}${safeHelp}${this.outerBorder("╯")}`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    if (safeWidth === 1) return Array.from({ length: height }, () => " ");
    const bodyHeight = height - 2;
    let body: string[];
    if (this.prompt) body = this.renderPrompt(safeWidth, bodyHeight, this.prompt);
    else {
      const showNotice = this.notice !== undefined && bodyHeight > 0;
      const contentHeight = Math.max(0, bodyHeight - (showNotice ? 1 : 0));
      const content =
        this.layout === "wide"
          ? this.renderWide(safeWidth, contentHeight, runs, selected)
          : this.layout === "stacked"
            ? this.renderStacked(safeWidth, contentHeight, runs, selected)
            : this.renderNarrow(safeWidth, contentHeight, runs, selected);
      body = showNotice ? [this.renderNotice(safeWidth, this.notice!), ...content] : content;
    }
    return [truncateToWidth(top, safeWidth, ""), ...body, truncateToWidth(bottom, safeWidth, "")];
  }

  private outerBorder(text: string): string {
    return this.options.theme.fg("borderAccent", text);
  }

  private innerBorder(text: string): string {
    return this.options.theme.fg("borderMuted", text);
  }

  private renderNotice(width: number, notice: FleetNotice): string {
    const inner = Math.max(0, width - 2);
    const glyph = managerNoticeGlyph(notice.kind);
    const color =
      notice.kind === "error" ? "error" : notice.kind === "success" ? "success" : "muted";
    return `${this.outerBorder("│")}${padListDetailRow(
      this.options.theme.fg(color, `${glyph} ${sanitizeTerminalLine(notice.text)}`),
      inner,
    )}${this.outerBorder("│")}`;
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
    const frame = (line: string) =>
      `${this.outerBorder("│")}${padListDetailRow(line, inner)}${this.outerBorder("│")}`;
    const rendered = rows.slice(0, height).map(frame);
    while (rendered.length < height) rendered.push(frame(""));
    return rendered;
  }

  private runLine(
    run: SubagentRunView,
    index: number,
    width: number,
    runs: ReadonlyArray<SubagentRunView>,
  ): string {
    const selected = index === this.selected;
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
    this.listPageSize = Math.max(1, limit);
    const start = listWindowStart(runs.length, this.selected, limit);
    return runs
      .slice(start, start + Math.max(1, limit))
      .map((run, offset) => ({ run, index: start + offset }));
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
    const actions = [
      messageAction,
      canInterrupt(selected) ? "i Interrupt" : undefined,
      canResume(selected) ? "r Resume" : undefined,
      canRename(selected) ? "n Rename" : undefined,
      canStop(selected) ? "x Stop" : undefined,
    ].filter((item): item is string => item !== undefined);
    const compactActions = [
      messageAction,
      canInterrupt(selected) ? "i Int" : undefined,
      canResume(selected) ? "r Resume" : undefined,
      canRename(selected) ? "n Name" : undefined,
      canStop(selected) ? "x Stop" : undefined,
    ].filter((item): item is string => item !== undefined);
    const scrollHelp = this.pane === "list" ? "C-u/d Half-page · gg/G Ends" : "C-u/d Detail · gg/G";
    // The expanded ? overlay is the discoverable place for the full motion vocabulary.
    const expandedScrollHelp =
      this.pane === "list"
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
    const window = computeDetailWindow({
      lines,
      height,
      previous: { scroll: this.detailScroll, lineCount: this.detailLineCount },
    });
    this.detailScroll = window.scroll;
    this.detailMaxScroll = window.maxScroll;
    this.detailPageSize = window.pageSize;
    this.detailLineCount = window.lineCount;
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
    const { listWidth: leftWidth, detailWidth: rightWidth } = wideListDetailGeometry(
      width,
      38,
      0.42,
    );
    const visible = this.visibleRuns(runs, Math.max(1, height - 1));
    const left = [
      this.options.theme.fg(
        this.pane === "list" ? "accent" : "muted",
        `${this.pane === "list" ? "› " : ""}${this.listHeading(runs, visible)}`,
      ),
      ...visible.map(({ run, index }) => this.runLine(run, index, leftWidth, runs)),
    ];
    const detail = this.detailWindow(this.detailLines(selected, rightWidth), height, rightWidth);
    return Array.from(
      { length: height },
      (_, index) =>
        `${this.outerBorder("│")}${padListDetailRow(left[index] ?? "", leftWidth)}${this.innerBorder(
          "│",
        )}${padListDetailRow(detail[index] ?? "", rightWidth)}${this.outerBorder("│")}`,
    );
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
    const list = [
      this.options.theme.fg(
        this.pane === "list" ? "accent" : "muted",
        `${this.pane === "list" ? "› " : ""}${this.listHeading(runs, visible)}`,
      ),
      ...visible.map(({ run, index }) => this.runLine(run, index, inner, runs)),
    ];
    const divider = `${this.outerBorder("├")}${this.innerBorder("─".repeat(inner))}${this.outerBorder("┤")}`;
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    const frame = (line: string) =>
      `${this.outerBorder("│")}${padListDetailRow(line, inner)}${this.outerBorder("│")}`;
    const lines = [...list.map(frame), divider, ...detail.map(frame)];
    while (lines.length < height) lines.push(frame(""));
    return lines.slice(0, height);
  }

  private renderNarrow(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.details && selected
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
    if (!this.details) {
      this.detailMaxScroll = 0;
      this.detailLineCount = 0;
    }
    const frame = (line: string) =>
      `${this.outerBorder("│")}${padListDetailRow(line, inner)}${this.outerBorder("│")}`;
    const rendered = lines.slice(0, height).map(frame);
    while (rendered.length < height) rendered.push(frame(""));
    return rendered;
  }

  invalidate(): void {
    this.prompt?.input.invalidate();
  }
}
