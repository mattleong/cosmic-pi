import * as Predicate from "effect/Predicate";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { toolStatusLine } from "pi-cosmic-ui/tool";
import { Input, type Component, type Focusable } from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
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
  type ListSelectionChange,
} from "pi-cosmic-ui/manager/list-detail";
import {
  framedFill,
  framedRow,
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  listDetailHeading,
  ListDetailShell,
  type ListDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import {
  captureSubagentControlExpectation,
  type SubagentControlExpectation,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import {
  CONFIRMATION_KEYS,
  FLEET_SHORTCUTS,
  MESSAGES,
  canConfirm,
  canStop,
  fixedTreeDirection,
  promptAvailable,
  promptUnavailableFeedback,
  shortcutUnavailableReason,
  sameFleetAssignment,
  type FleetPrompt,
  type FleetPromptKind,
  type PendingConfirmation,
} from "./fleet-policy.ts";
import {
  fleetHelpText,
  fleetListHeading,
  fleetRunLine,
  fleetTitle,
  renderFleetPrompt,
} from "./fleet-render.ts";
import { projectFleetTree, type FleetTreeRow } from "./run-tree-rows.ts";
import { renderSubagentSessionOutput } from "./session-output.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  runMessageMode,
  type RunMessageMode,
} from "./run-state.ts";
import { duplicateRunNames } from "./run-presentation.ts";

type FleetMessageMode = RunMessageMode;

export type FleetMessageDelivery = "delivered" | "pending";

export interface FleetActions {
  readonly stop: (id: string, expected: SubagentControlExpectation) => Promise<void>;
  readonly interrupt: (id: string, expected: SubagentControlExpectation) => Promise<void>;
  readonly resume: (
    id: string,
    message: string | undefined,
    expected: SubagentControlExpectation,
  ) => Promise<void>;
  readonly message: (
    id: string,
    mode: FleetMessageMode,
    message: string,
    expected: SubagentControlExpectation,
  ) => Promise<FleetMessageDelivery>;
  readonly rename: (
    id: string,
    name: string,
    expected: SubagentControlExpectation,
  ) => Promise<void>;
}

interface FleetOptions {
  readonly theme: Theme;
  readonly getProjection: () => SubagentProjection;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly matchesKeybinding?:
    | ((data: string, id: FullScreenSelectionKeybindingId) => boolean)
    | undefined;
  readonly keybindingLabel?:
    | ((id: FullScreenSelectionKeybindingId, fallback: string) => string)
    | undefined;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly actions: FleetActions;
  readonly onDispose?: (() => void) | undefined;
  readonly isCurrent?: (() => boolean) | undefined;
}

type FleetNoticeKind = "info" | "success" | "warning" | "error";
type FleetNotice = { readonly kind: FleetNoticeKind; readonly text: string };

export class SubagentFleetComponent implements Component, Focusable {
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pending: PendingConfirmation | undefined;
  private prompt: FleetPrompt | undefined;
  private notice: FleetNotice | undefined;
  private busyAction: string | undefined;
  private focusState = false;
  private disposed = false;
  private readonly shell = new ListDetailShell();
  private readonly options: FleetOptions;
  private readonly collapsedRunIds = new Set<string>();

  constructor(options: FleetOptions) {
    this.options = options;
  }

  private get frame(): ListDetailFrame {
    return listDetailFrame(this.options.theme, this.shell.state.pane);
  }

  private tree(projection: SubagentProjection) {
    return projectFleetTree(projection.runs, "root", this.collapsedRunIds);
  }

  get noticeKind(): FleetNoticeKind | undefined {
    return this.notice?.kind;
  }

  get focused(): boolean {
    return this.focusState;
  }

  set focused(value: boolean) {
    this.focusState = value;
    if (this.prompt) this.prompt.input.focused = value;
  }

  private applySelection(next: ListSelectionChange): void {
    if (next.changed) this.pending = undefined;
  }

  private resolveInput(data: string, mode: FullScreenMode, reservedKeys?: ReadonlySet<string>) {
    return this.shell.keymap.resolve(data, {
      mode,
      matchesKeybinding: this.options.matchesKeybinding,
      ...(reservedKeys && { reservedKeys }),
    });
  }

  private reconcile(rows: ReadonlyArray<FleetTreeRow>): void {
    this.applySelection(this.shell.reconcile(rows.map((row) => row.run.id)));
    const selected = rows[this.shell.state.selected]?.run;
    if (this.pending && (this.pending.id !== selected?.id || !canConfirm(this.pending, selected)))
      this.pending = undefined;
    if (this.prompt && this.prompt.runId !== selected?.id) this.prompt = undefined;
  }

  private openPrompt(run: SubagentRunView, kind: FleetPromptKind): void {
    const input = new Input();
    input.focused = this.focusState;
    const question = kind === "reply" ? run.question?.message : undefined;
    this.prompt = {
      kind,
      runId: run.id,
      runName: sanitizeTerminalLine(run.name),
      run,
      input,
      ...(question && { context: sanitizeTerminalLine(question) }),
    };
    this.notice = undefined;
  }

  private performAction(progress: string, success: string, operation: () => Promise<void>): void {
    this.performOutcome(progress, operation, () => ({ kind: "success", text: success }));
  }

  private performOutcome<A>(
    progress: string,
    operation: () => Promise<A>,
    settled: (value: A) => FleetNotice,
  ): void {
    this.busyAction = progress;
    this.notice = { kind: "info", text: progress };
    this.options.requestRender();
    const settle = (notice: FleetNotice): void => {
      if (!this.current()) return;
      this.busyAction = undefined;
      this.notice = notice;
      this.options.requestRender();
    };
    const fail = (cause: unknown): void =>
      settle({
        kind: "error",
        text: cause instanceof Error ? cause.message : "Subagent operation failed.",
      });
    let result: Promise<A>;
    try {
      result = operation();
    } catch (cause) {
      queueMicrotask(() => fail(cause));
      return;
    }
    void result.then((value) => settle(settled(value)), fail);
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
    const current = this.options.getProjection().runs.find((run) => run.id === prompt.runId);
    if (current && !sameFleetAssignment(prompt.run, current)) {
      prompt.feedback = "Nothing was sent: this assignment or question changed. Reopen the input.";
      this.options.requestRender();
      return;
    }
    if (!promptAvailable(prompt.kind, current)) {
      prompt.feedback = promptUnavailableFeedback(prompt.kind, current);
      this.options.requestRender();
      return;
    }
    this.prompt = undefined;
    const name = prompt.runName;
    if (prompt.kind === "resume") {
      this.performAction(`Resuming ${name}…`, `Resumed ${name}.`, () =>
        this.options.actions.resume(
          prompt.runId,
          message || undefined,
          captureSubagentControlExpectation(prompt.run),
        ),
      );
      return;
    }
    if (prompt.kind === "rename") {
      this.performAction(
        `Renaming ${name}…`,
        `Renamed ${name} to ${sanitizeTerminalLine(message)}.`,
        () =>
          this.options.actions.rename(
            prompt.runId,
            message,
            captureSubagentControlExpectation(prompt.run),
          ),
      );
      return;
    }
    const mode: FleetMessageMode = prompt.kind;
    const { label, progress } = MESSAGES[mode];
    this.performOutcome(
      `${progress}…`,
      () =>
        this.options.actions.message(
          prompt.runId,
          mode,
          message,
          captureSubagentControlExpectation(prompt.run),
        ),
      (delivery): FleetNotice =>
        delivery === "delivered"
          ? { kind: "success", text: `${label} sent to ${name}.` }
          : { kind: "warning", text: `${label} for ${name} is waiting for delivery confirmation` },
    );
  }

  handleInput(data: string): void {
    if (!this.current()) return;
    const projection = this.options.getProjection();
    const rows = this.tree(projection).rows;
    this.reconcile(rows);
    const selectedRow = rows[this.shell.state.selected];
    const selected = selectedRow?.run;

    if (this.prompt) return this.handlePromptInput(data, this.prompt);
    if (this.pending && selected) return this.handlePendingInput(data, this.pending, selected);
    if (this.busyAction) return this.handleBusyInput(data);

    this.notice = undefined;
    if (this.handleFixedTreeInput(data, projection, selectedRow)) return;
    const resolution = this.resolveInput(data, "navigation", FLEET_SHORTCUTS);
    if (!resolution) return;
    if (Predicate.isTagged(resolution, "Shortcut")) this.handleShortcut(resolution.key, selected);
    else this.handleNavigation(resolution.action, rows, selected);
  }

  private handlePromptInput(data: string, prompt: FleetPrompt): void {
    const resolution = this.resolveInput(data, "text-input");
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.prompt = undefined;
      this.notice = { kind: "info", text: "Input cancelled" };
      this.options.requestRender();
    } else if (resolution?._tag === "Action" && resolution.action === "confirm")
      this.submitPrompt();
    else {
      prompt.feedback = undefined;
      prompt.input.handleInput(data);
      this.options.requestRender();
    }
  }

  private handlePendingInput(
    data: string,
    pending: PendingConfirmation,
    run: SubagentRunView,
  ): void {
    const key = CONFIRMATION_KEYS[pending.action];
    const resolution = this.resolveInput(data, "confirmation", new Set([key]));
    if (
      (resolution?._tag === "Action" && resolution.action === "confirm") ||
      confirmedReservedShortcut(resolution, data, key)
    ) {
      this.pending = undefined;
      const name = sanitizeTerminalLine(run.name);
      if (pending.action === "stop")
        this.performAction(
          `Stopping ${name} and its subagents…`,
          `Stopped ${name} and its subagents`,
          () => this.options.actions.stop(run.id, captureSubagentControlExpectation(pending.run)),
        );
      else
        this.performAction(`Interrupting ${name}…`, `Interrupted ${name}; it is paused`, () =>
          this.options.actions.interrupt(run.id, captureSubagentControlExpectation(pending.run)),
        );
      return;
    }
    if (resolution?._tag === "Action" && resolution.action === "cancel") {
      this.pending = undefined;
      this.notice = {
        kind: "info",
        text: pending.action === "stop" ? "Stop cancelled" : "Interrupt cancelled",
      };
    }
    this.options.requestRender();
  }

  private handleBusyInput(data: string): void {
    const resolution = this.resolveInput(data, "busy");
    if (
      resolution?._tag === "Action" &&
      (resolution.action === "cancel" || resolution.action === "quit")
    )
      this.options.close();
  }

  private handleFixedTreeInput(
    data: string,
    projection: SubagentProjection,
    selectedRow: FleetTreeRow | undefined,
  ): boolean {
    const direction = fixedTreeDirection(data, this.shell.state.pane);
    if (!direction || !selectedRow?.hasChildren) return false;
    if (direction === "back") this.collapsedRunIds.add(selectedRow.run.id);
    else if (!this.collapsedRunIds.delete(selectedRow.run.id)) return false;
    this.shell.resetDetailScroll();
    this.reconcile(this.tree(projection).rows);
    this.options.requestRender();
    return true;
  }

  private handleShortcut(key: string, selected: SubagentRunView | undefined): void {
    if (key === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.shell.resetDetailScroll();
    } else if (!selected) this.notice = { kind: "info", text: "Select a subagent first" };
    else if (!this.applyRunShortcut(key, selected))
      this.notice = { kind: "info", text: shortcutUnavailableReason(key, selected) };
    this.options.requestRender();
  }

  private applyRunShortcut(key: string, selected: SubagentRunView): boolean {
    const mode = runMessageMode(selected);
    if (key === "x" && canStop(selected))
      this.pending = { action: "stop", id: selected.id, run: selected };
    else if (key === "i" && canInterruptRun(selected))
      this.pending = { action: "interrupt", id: selected.id, run: selected };
    else if (key === "u" && canResumeRun(selected)) this.openPrompt(selected, "resume");
    else if (key === "m" && mode) this.openPrompt(selected, mode);
    else if (key === "e" && canRenameRun(selected)) this.openPrompt(selected, "rename");
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
      if (Predicate.isTagged(result, "Close")) {
        this.options.close();
        return;
      }
      if (Predicate.isTagged(result, "Update") && result.movedSelection)
        this.applySelection(
          this.shell.select(
            result.state.selected,
            rows.map((row) => row.run.id),
          ),
        );
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    if (!this.current()) return [];
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.shell.syncLayout(safeWidth);
    const tree = this.tree(this.options.getProjection());
    const rows = tree.rows;
    this.reconcile(rows);
    const selected = rows[this.shell.state.selected]?.run;
    this.shell.ensureSelectionPane(selected !== undefined);
    const title = fleetTitle(tree.runs, rows.length, safeWidth);
    return framedScreen(this.frame, {
      width: safeWidth,
      height,
      top: this.options.theme.fg("accent", title),
      bottom: this.helpText(safeWidth, selected),
      body: (bodyHeight) => {
        if (this.prompt) return this.renderPrompt(safeWidth, bodyHeight, this.prompt);
        const notice = bodyHeight > 0 ? this.notice : undefined;
        const content = this.renderBody(
          safeWidth,
          Math.max(0, bodyHeight - (notice ? 1 : 0)),
          rows,
          duplicateRunNames(tree.runs),
          selected,
        );
        return notice ? [this.renderNotice(safeWidth, notice), ...content] : content;
      },
    });
  }

  private renderNotice(width: number, notice: FleetNotice): string {
    const line = toolStatusLine(this.options.theme, notice.kind, notice.text);
    return framedRow(this.frame, line, Math.max(0, width - 2));
  }

  private renderPrompt(width: number, height: number, prompt: FleetPrompt): string[] {
    return renderFleetPrompt(this.options.theme, this.frame, prompt, width, height);
  }

  private runLine(
    row: FleetTreeRow,
    index: number,
    width: number,
    duplicates: ReadonlySet<string>,
  ): string {
    const selected = index === this.shell.state.selected;
    return fleetRunLine(
      this.options.theme,
      row,
      {
        selected,
        focused: selected && this.shell.state.pane === "list",
        now: this.options.getNow(),
        duplicates,
      },
      width,
    );
  }

  private listPane(
    rows: ReadonlyArray<FleetTreeRow>,
    limit: number,
    width: number,
    duplicates: ReadonlySet<string>,
  ): string[] {
    const { start, end } = this.shell.visibleWindow(rows.length, limit);
    const visible = rows.slice(start, end).map((row, offset) => ({ row, index: start + offset }));
    const pane = this.shell.state.pane === "list";
    return [
      listDetailHeading(this.options.theme, fleetListHeading(rows, visible), pane),
      ...visible.map(({ row, index }) => this.runLine(row, index, width, duplicates)),
    ];
  }

  private helpText(width: number, selected: SubagentRunView | undefined): string {
    return fleetHelpText(width, selected, {
      prompting: this.prompt !== undefined,
      busyAction: this.busyAction,
      pending: this.pending,
      alternateHelp: this.alternateHelp,
      listPane: this.shell.state.pane === "list",
      keybindingLabel: this.options.keybindingLabel,
    });
  }

  private detailLines(run: SubagentRunView | undefined, width: number): string[] {
    if (!run) return [this.options.theme.fg("dim", "No subagents yet")];
    return renderSubagentSessionOutput(run, this.options.theme, {
      now: this.options.getNow(),
      showTechnicalDetails: this.showTechnicalDetails,
      detailFocused: this.shell.state.pane === "detail",
    }).render(Math.max(1, width));
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    const window = this.shell.detailWindow(lines, height);
    if (!window.overflow) return [...window.visible];
    const position = this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow));
    return [padListDetailRow(position, width), ...window.visible];
  }

  private renderBody(
    width: number,
    height: number,
    rows: ReadonlyArray<FleetTreeRow>,
    duplicates: ReadonlySet<string>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const list = (limit: number, listWidth: number) =>
      this.listPane(rows, limit, listWidth, duplicates);
    const detail = (detailWidth: number, detailHeight: number) =>
      this.detailWindow(this.detailLines(selected, detailWidth), detailHeight, detailWidth);
    if (this.shell.state.layout === "wide") {
      const { listWidth, detailWidth } = wideListDetailGeometry(width, 38, 0.42);
      const left = list(Math.max(1, height - 1), listWidth);
      const right = detail(detailWidth, height);
      return framedWideRows(this.frame, { left, right, height, listWidth, detailWidth });
    }
    if (this.shell.state.layout === "stacked") {
      const listRows = list(stackedListHeight(height, rows.length) - 1, inner);
      const detailRows = detail(inner, Math.max(0, height - listRows.length - 1));
      return framedStackedRows(this.frame, { list: listRows, detail: detailRows, height, inner });
    }
    const lines =
      this.shell.state.details && selected
        ? detail(inner, height)
        : rows.length
          ? list(Math.max(1, height - 1), inner).slice(height <= 1 ? 1 : 0)
          : [this.options.theme.fg("dim", "No subagents yet")];
    if (!this.shell.state.details) this.shell.resetDetailWindow();
    return framedFill(this.frame, lines, height, inner, this.shell.state.pane);
  }

  invalidate(): void {
    this.prompt?.input.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.options.onDispose?.();
  }

  private current(): boolean {
    if (this.disposed) return false;
    if (this.options.isCurrent?.() !== false) return true;
    this.dispose();
    this.options.close();
    return false;
  }
}
