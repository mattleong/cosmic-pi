import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  managerNoticeGlyph,
  renderResponsiveManagerFooter,
  clipToWidth,
  spinnerFrameAt,
} from "pi-cosmic-ui/manager";
import {
  Input,
  Key,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, formatRelativeAge, countLabel } from "pi-cosmic-core";
import { filterReservedKeyLabel } from "pi-cosmic-ui/manager/key-labels";
import {
  decodeFullScreenPrintable,
  type FullScreenAction,
  type FullScreenMode,
  type FullScreenSelectionKeybindingId,
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
  listDetailHeading,
  ListDetailShell,
  type ListDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import {
  hasSubagentCapability,
  hasUnresolvedSteeringDelivery,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import { projectFleetTree, runTreeBranch, type FleetTreeRow } from "./run-tree-rows.ts";
import { renderSubagentSessionOutput } from "./session-output.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";
import { shortRunId } from "./run-presentation.ts";

export type FleetMessageMode = "guidance" | "reply" | "next-assignment";

/**
 * `delivered` means the owning coordinator accepted the message. `pending` means native delivery
 * remains backend-owned and unconfirmed: it is neither delivered nor failed and must not be resent.
 */
export type FleetMessageDelivery = "delivered" | "pending";

export interface FleetActions {
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly message: (
    id: string,
    mode: FleetMessageMode,
    message: string,
  ) => Promise<FleetMessageDelivery>;
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
  /** Host subscriptions released when the surface disposes this component. */
  readonly onDispose?: (() => void) | undefined;
}

/**
 * The one message a run can currently accept. Pending or unresolved native guidance rejects new
 * input and queue-cancelling interruption; parent-question replies and stop stay available.
 */
const messageMode = (run: SubagentRunView | undefined): FleetMessageMode | undefined => {
  if (!run) return undefined;
  if (run.state === "waiting_for_parent")
    return hasSubagentCapability(run, "parent-contact") ? "reply" : undefined;
  if (hasUnresolvedSteeringDelivery(run)) return undefined;
  if (run.state === "reported" && run.closeOnReport === false) return "next-assignment";
  if (run.state === "running" && hasSubagentCapability(run, "steer")) return "guidance";
  return undefined;
};
const canInterrupt = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "interrupt") &&
    !hasUnresolvedSteeringDelivery(run) &&
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

const FLEET_SHORTCUTS = new Set(["e", "i", "m", "t", "u", "x"]);

/** Actions that change a run's lifecycle wait for their own key again, or Enter. */
type PendingConfirmation = { readonly action: "stop" | "interrupt"; readonly id: string };
const CONFIRMATION_KEYS = { stop: "x", interrupt: "i" } as const;
const canConfirm = (pending: PendingConfirmation, run: SubagentRunView | undefined) =>
  pending.action === "stop" ? canStop(run) : canInterrupt(run);

const UNRESOLVED_GUIDANCE_REASON =
  "Guidance delivery to this run is still unresolved; wait for it to settle or stop the run.";

const shortcutUnavailableReason = (key: string, run: SubagentRunView): string =>
  (key === "m" || key === "i") && hasUnresolvedSteeringDelivery(run)
    ? UNRESOLVED_GUIDANCE_REASON
    : key === "m"
      ? "This run cannot receive guidance, a reply, or a new assignment in its current state."
      : key === "i"
        ? "This run cannot be interrupted in its current state or backend."
        : key === "u"
          ? "This run cannot be resumed in its current state or backend."
          : key === "e"
            ? "This run cannot be renamed in its current state or backend."
            : "This run is not currently stoppable.";

/** Fixed list-pane tree keys resolve before the configurable navigation keymap. */
const fixedTreeDirection = (data: string, pane: ListDetailPane): "back" | "forward" | undefined => {
  if (pane !== "list") return undefined;
  const printable = decodeFullScreenPrintable(data);
  if (printable === "h" || matchesKey(data, Key.left)) return "back";
  if (printable === "l" || matchesKey(data, Key.right)) return "forward";
  return undefined;
};

interface FleetActionLabel {
  readonly full: string;
  readonly compact: string;
}

const FLEET_ACTION_LABELS = [
  [canInterrupt, "i Interrupt", "i Int"],
  [canResume, "u Resume", "u Resume"],
  [canRename, "e Rename", "e Name"],
  [canStop, "x Stop subtree", "x Stop tree"],
] as const;

const fleetActionLabels = (selected: SubagentRunView): ReadonlyArray<FleetActionLabel> => {
  const labels: FleetActionLabel[] = [];
  const mode = messageMode(selected);
  if (mode) {
    const messageLabel =
      mode === "reply" ? "m Reply" : mode === "next-assignment" ? "m New task" : "m Guide";
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

/** Submission rechecks the live run, so a prompt opened earlier can never act on a stale state. */
const promptAvailable = (kind: FleetPromptKind, run: SubagentRunView | undefined): boolean =>
  kind === "resume"
    ? canResume(run)
    : kind === "rename"
      ? canRename(run)
      : messageMode(run) === kind;

const promptUnavailableFeedback = (kind: FleetPromptKind, run: SubagentRunView | undefined) =>
  run && (kind === "guidance" || kind === "next-assignment") && hasUnresolvedSteeringDelivery(run)
    ? "Nothing was sent: earlier guidance delivery is still unresolved."
    : "Nothing was sent: this run no longer accepts this input in its current state.";

const MESSAGE_LABELS = {
  reply: "Reply",
  "next-assignment": "Next assignment",
  guidance: "Guidance",
} as const satisfies Record<FleetMessageMode, string>;

export type FleetNoticeKind = "info" | "success" | "warning" | "error";
type FleetNotice = { readonly kind: FleetNoticeKind; readonly text: string };
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
  private pending: PendingConfirmation | undefined;
  private prompt: FleetPrompt | undefined;
  private notice: FleetNotice | undefined;
  private busyAction: string | undefined;
  private _focused = false;
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
    return projectFleetTree(
      projection.runs,
      this.options.visibilityRootId ?? "root",
      this.collapsedRunIds,
    );
  }

  /** The settled or in-progress action outcome currently shown to the user, if any. */
  get noticeKind(): FleetNoticeKind | undefined {
    return this.notice?.kind;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    if (this.prompt) this.prompt.input.focused = value;
  }

  private applySelection(next: ListSelectionChange): void {
    if (next.changed) this.pending = undefined;
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
    if (this.pending && (this.pending.id !== selected?.id || !canConfirm(this.pending, selected)))
      this.pending = undefined;
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
    this.performOutcome(progress, operation, () => ({ kind: "success", text: success }));
  }

  /** Runs one action once; only its own settled value decides the notice, never a retry. */
  private performOutcome<A>(
    progress: string,
    operation: () => Promise<A>,
    settled: (value: A) => FleetNotice,
  ): void {
    this.busyAction = progress;
    this.notice = { kind: "info", text: progress };
    this.options.requestRender();
    const settle = (notice: FleetNotice): void => {
      this.busyAction = undefined;
      this.notice = notice;
      this.options.requestRender();
    };
    let result: Promise<A>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result).then(
      (value) => settle(settled(value)),
      (error) =>
        settle({
          kind: "error",
          text: error instanceof Error ? error.message : "Subagent operation failed.",
        }),
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
    const current = this.options.getProjection().runs.find((run) => run.id === prompt.runId);
    if (!promptAvailable(prompt.kind, current)) {
      // Keep the typed text: the run may become eligible again, and Esc still cancels.
      prompt.feedback = promptUnavailableFeedback(prompt.kind, current);
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
    this.performOutcome(
      `${verb}…`,
      () => this.options.actions.message(prompt.runId, mode, message),
      (delivery): FleetNotice =>
        delivery === "delivered"
          ? { kind: "success", text: success }
          : delivery === "pending"
            ? {
                kind: "warning",
                text: `${MESSAGE_LABELS[mode]} for ${name} is waiting for delivery confirmation`,
              }
            : {
                kind: "error",
                text: `${MESSAGE_LABELS[mode]} for ${name} wasn't confirmed and may have arrived; check the run before sending again`,
              },
    );
  }

  handleInput(data: string): void {
    const projection = this.options.getProjection();
    const rows = this.tree(projection).rows;
    this.reconcile(rows);
    const selectedRow = rows[this.shell.state.selected];
    const selected = selectedRow?.run;

    if (this.prompt) return this.handlePromptInput(data, this.prompt);
    if (this.pending) return this.handlePendingInput(data, this.pending, selected);
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
    selected: SubagentRunView | undefined,
  ): void {
    const key = CONFIRMATION_KEYS[pending.action];
    const resolution = this.resolveInput(data, "confirmation", new Set([key]));
    const run = selected && pending.id === selected.id ? selected : undefined;
    const confirmed =
      resolution?._tag === "Action" && resolution.action === "confirm"
        ? true
        : confirmedReservedShortcut(resolution, data, key);
    if (confirmed && run && canConfirm(pending, run)) {
      this.pending = undefined;
      const name = sanitizeTerminalLine(run.name);
      if (pending.action === "stop")
        this.performAction(
          `Stopping ${name} and its subagents…`,
          `Stopped ${name} and its subagents`,
          () => this.options.actions.stop(run.id),
        );
      else
        this.performAction(`Interrupting ${name}…`, `Interrupted ${name}; it is paused`, () =>
          this.options.actions.interrupt(run.id),
        );
      return;
    }
    if (!run || (resolution?._tag === "Action" && resolution.action === "cancel")) {
      this.pending = undefined;
      this.notice = {
        kind: "info",
        text: pending.action === "stop" ? "Stop cancelled" : "Interrupt cancelled",
      };
    }
    this.options.requestRender();
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
      const collapsed = this.collapsedRunIds.has(selectedRow.run.id);
      if (direction === "back") this.collapsedRunIds.add(selectedRow.run.id);
      else if (collapsed) this.collapsedRunIds.delete(selectedRow.run.id);
      else return false;
      this.shell.resetDetailScroll();
      this.reconcile(this.tree(projection).rows);
      this.options.requestRender();
      return true;
    }
    return false;
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

  /** Applies one run shortcut; returns false when it does not apply to the run's state or backend. */
  private applyRunShortcut(key: string, selected: SubagentRunView): boolean {
    const mode = messageMode(selected);
    if (key === "x" && canStop(selected)) this.pending = { action: "stop", id: selected.id };
    else if (key === "i" && canInterrupt(selected))
      this.pending = { action: "interrupt", id: selected.id };
    else if (key === "u" && canResume(selected)) this.openPrompt(selected, "resume");
    else if (key === "m" && mode) this.openPrompt(selected, mode);
    else if (key === "e" && canRename(selected)) this.openPrompt(selected, "rename");
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
    const titleRaw = ` /subagents · ${countLabel(tree.runs.length, "run")}${hidden ? ` · ${rows.length} visible` : ""}${working ? ` · ${working} running` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""}${retained ? ` · ${retained} reported` : ""} `;
    const title = clipToWidth(titleRaw, Math.max(0, safeWidth - 2), "");
    const help = this.helpText(safeWidth, selected);
    const safeHelp = clipToWidth(help, Math.max(0, safeWidth - 2), "");
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
    const color = notice.kind === "info" ? "muted" : notice.kind;
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
    const selection = selected
      ? this.options.theme.fg(this.shell.state.pane === "list" ? "accent" : "muted", ">")
      : " ";
    const branch = this.options.theme.fg("dim", runTreeBranch(row));
    const disclosure = row.hasChildren
      ? this.options.theme.fg("muted", row.expanded ? "▾" : "▸")
      : " ";
    const frame = spinnerFrameAt(this.options.getNow());
    const glyph = this.options.theme.fg(
      runStateColor(run.state),
      animatedRunStateGlyph(run.state, frame),
    );
    const state =
      run.state === "completed" || run.state === "reported"
        ? `${runStateLabel(run.state)} ${formatRelativeAge(this.options.getNow() - (run.endedAt ?? run.lastActivityAt))}`
        : runStateLabel(run.state);
    const duplicateName = scopeRuns.some(
      (candidate) => candidate.id !== run.id && candidate.name === run.name,
    );
    const shortId = shortRunId(run.id);
    const identity = duplicateName ? `[${shortId}] ${run.name}` : run.name;
    const label = sanitizeTerminalLine(
      `${identity} · ${state} · ${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`,
    );
    return padListDetailRow(
      `${selection} ${branch}${disclosure} ${glyph} ${
        selected && this.shell.state.pane === "list"
          ? focusedField(this.options.theme, label)
          : this.options.theme.fg(managerTone.identity, sanitizeTerminalLine(identity)) +
            this.options.theme.fg(
              "muted",
              ` · ${sanitizeTerminalLine(`${state} · ${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`)}`,
            )
      }`,
      width,
    );
  }

  private listPane(
    rows: ReadonlyArray<FleetTreeRow>,
    limit: number,
    width: number,
    scopeRuns: ReadonlyArray<SubagentRunView>,
  ): string[] {
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    const { start, end } = this.shell.visibleWindow(rows.length, limit);
    const visible = rows.slice(start, end).map((row, offset) => ({ row, index: start + offset }));
    const pane = this.shell.state.pane === "list";
    return [
      listDetailHeading(this.options.theme, this.listHeading(rows, visible), pane),
      ...visible.map(({ row, index }) => this.runLine(row, index, width, scopeRuns)),
    ];
  }

  private listHeading(
    rows: ReadonlyArray<FleetTreeRow>,
    visible: ReadonlyArray<{ readonly index: number }>,
  ): string {
    if (rows.length === 0) return "Subagents";
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
        : this.pending
          ? [
              [
                `${CONFIRMATION_KEYS[this.pending.action]} Confirm ${this.pending.action} ${sanitizeTerminalLine(selected?.name ?? "selected subagent")}`,
                `${escape}/q Cancel`,
              ],
            ]
          : undefined;
    if (modal) return renderResponsiveManagerFooter(contentWidth, modal);
    if (!selected) return renderResponsiveManagerFooter(contentWidth, [[`${escape}/q Close`]]);
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
    if (!run) return [this.options.theme.fg("dim", "No subagents yet")];
    return renderSubagentSessionOutput(run, this.options.theme, {
      now: this.options.getNow(),
      showTechnicalDetails: this.showTechnicalDetails,
      detailFocused: this.shell.state.pane === "detail",
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
    const left = this.listPane(rows, Math.max(1, height - 1), listWidth, scopeRuns);
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
    const list = this.listPane(rows, stackedListHeight(height, rows.length) - 1, inner, scopeRuns);
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
          ? this.listPane(rows, Math.max(1, height - 1), inner, scopeRuns).slice(
              height <= 1 ? 1 : 0,
            )
          : [this.options.theme.fg("dim", "No subagents yet")];
    if (!this.shell.state.details) this.shell.resetDetailWindow();
    return framedFill(this.frame, lines, height, inner, this.shell.state.pane);
  }

  invalidate(): void {
    this.prompt?.input.invalidate();
  }

  dispose(): void {
    this.options.onDispose?.();
  }
}
