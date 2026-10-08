import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderResponsiveManagerFooter, clipToWidth, spinnerFrameAt } from "pi-cosmic-ui/manager";
import { toolStatusLine } from "pi-cosmic-ui/tool";
import {
  Input,
  Key,
  matchesKey,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine, formatRelativeAge, countLabel } from "pi-cosmic-core";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
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
  hasUnresolvedSteeringDelivery,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import { projectFleetTree, runTreeBranch, type FleetTreeRow } from "./run-tree-rows.ts";
import { renderSubagentSessionOutput } from "./session-output.ts";
import {
  canInterruptRun,
  canRenameRun,
  canResumeRun,
  runMessageMode,
  runStateColor,
  runStateGlyph,
  runStateLabel,
  type RunMessageMode,
} from "./run-state.ts";
import { duplicateRunNames, shortRunId } from "./run-presentation.ts";

export type FleetMessageMode = RunMessageMode;

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
  /** Nested Pi cannot navigate above this authenticated run. Root uses the virtual root node. */
  readonly visibilityRootId?: string | undefined;
  /** Host subscriptions released when the surface disposes this component. */
  readonly onDispose?: (() => void) | undefined;
}

/** Unlike Activity's stop, the fleet's isn't offered again while the run is already stopping. */
const canStop = (run: SubagentRunView): boolean =>
  isActiveRunState(run.state) && run.state !== "stopping";

type FleetPromptKind = FleetMessageMode | "resume" | "rename";

const FLEET_SHORTCUTS = new Set(["e", "i", "m", "t", "u", "x"]);

/** Actions that change a run's lifecycle wait for their own key again, or Enter. */
type PendingConfirmation = { readonly action: "stop" | "interrupt"; readonly id: string };
const CONFIRMATION_KEYS = { stop: "x", interrupt: "i" } as const;
const canConfirm = (pending: PendingConfirmation, run: SubagentRunView) =>
  pending.action === "stop" ? canStop(run) : canInterruptRun(run);

/** Why a run shortcut doesn't apply; stop's reason is the fallback. */
const UNAVAILABLE_REASONS = new Map([
  ["m", "This run cannot receive guidance, a reply, or a new assignment in its current state."],
  ["i", "This run cannot be interrupted in its current state or backend."],
  ["u", "This run cannot be resumed in its current state or backend."],
  ["e", "This run cannot be renamed in its current state or backend."],
]);

const shortcutUnavailableReason = (key: string, run: SubagentRunView): string =>
  (key === "m" || key === "i") && hasUnresolvedSteeringDelivery(run)
    ? "Guidance delivery to this run is still unresolved; wait for it to settle or stop the run."
    : (UNAVAILABLE_REASONS.get(key) ?? "This run is not currently stoppable.");

/** Fixed list-pane tree keys resolve before the configurable navigation keymap. */
const fixedTreeDirection = (data: string, pane: ListDetailPane): "back" | "forward" | undefined => {
  if (pane !== "list") return undefined;
  const printable = decodeFullScreenPrintable(data);
  if (printable === "h" || matchesKey(data, Key.left)) return "back";
  if (printable === "l" || matchesKey(data, Key.right)) return "forward";
  return undefined;
};

/** Each message's words: in notices, as its shortcut, and while it is sent. */
const MESSAGES = {
  reply: { label: "Reply", shortcut: "m Reply", progress: "Sending reply" },
  guidance: { label: "Guidance", shortcut: "m Guide", progress: "Sending guidance" },
};

const FLEET_ACTION_LABELS = [
  { can: canInterruptRun, full: "i Interrupt", compact: "i Int" },
  { can: canResumeRun, full: "u Resume", compact: "u Resume" },
  { can: canRenameRun, full: "e Rename", compact: "e Name" },
  { can: canStop, full: "x Stop subtree", compact: "x Stop tree" },
];

/** The selected run's shortcuts in full and compact words; neither when it offers none. */
const fleetActionLabels = (selected: SubagentRunView) => {
  const mode = runMessageMode(selected);
  const labels = [
    ...(mode ? [{ full: MESSAGES[mode].shortcut, compact: MESSAGES[mode].shortcut }] : []),
    ...FLEET_ACTION_LABELS.filter(({ can }) => can(selected)),
  ];
  return labels.length === 0
    ? {}
    : {
        actions: labels.map((label) => label.full).join(" · "),
        compactActions: labels.map((label) => label.compact).join(" · "),
      };
};

/** Each prompt's title, before the run's name, and its instruction. */
const PROMPTS = {
  reply: { title: "Reply to", instruction: "Answer the pending question" },
  guidance: { title: "Guide", instruction: "Enter guidance for the active assignment" },
  resume: { title: "Resume", instruction: "Optional continuation message; submit blank to resume" },
  rename: { title: "Rename", instruction: "Enter a new display name" },
};

/** Submission rechecks the live run, so a prompt opened earlier can never act on a stale state. */
const promptAvailable = (kind: FleetPromptKind, run: SubagentRunView | undefined): boolean =>
  run !== undefined &&
  (kind === "resume"
    ? canResumeRun(run)
    : kind === "rename"
      ? canRenameRun(run)
      : runMessageMode(run) === kind);

const promptUnavailableFeedback = (kind: FleetPromptKind, run: SubagentRunView | undefined) =>
  run && kind === "guidance" && hasUnresolvedSteeringDelivery(run)
    ? "Nothing was sent: earlier guidance delivery is still unresolved."
    : "Nothing was sent: this run no longer accepts this input in its current state.";

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
    const { label, progress } = MESSAGES[mode];
    this.performOutcome(
      `${progress}…`,
      () => this.options.actions.message(prompt.runId, mode, message),
      (delivery): FleetNotice =>
        delivery === "delivered"
          ? { kind: "success", text: `${label} sent to ${name}.` }
          : { kind: "warning", text: `${label} for ${name} is waiting for delivery confirmation` },
    );
  }

  handleInput(data: string): void {
    const projection = this.options.getProjection();
    const rows = this.tree(projection).rows;
    this.reconcile(rows);
    const selectedRow = rows[this.shell.state.selected];
    const selected = selectedRow?.run;

    if (this.prompt) return this.handlePromptInput(data, this.prompt);
    // Reconciling kept a confirmation only while its run stays selected and can still take it.
    if (this.pending && selected) return this.handlePendingInput(data, this.pending, selected);
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
          () => this.options.actions.stop(run.id),
        );
      else
        this.performAction(`Interrupting ${name}…`, `Interrupted ${name}; it is paused`, () =>
          this.options.actions.interrupt(run.id),
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

  /** Applies one run shortcut; returns false when it does not apply to the run's state or backend. */
  private applyRunShortcut(key: string, selected: SubagentRunView): boolean {
    const mode = runMessageMode(selected);
    if (key === "x" && canStop(selected)) this.pending = { action: "stop", id: selected.id };
    else if (key === "i" && canInterruptRun(selected))
      this.pending = { action: "interrupt", id: selected.id };
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
      if (result._tag === "Close") {
        this.options.close();
        return;
      }
      if (result._tag === "Update" && result.movedSelection)
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
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.shell.syncLayout(safeWidth);
    const tree = this.tree(this.options.getProjection());
    const rows = tree.rows;
    this.reconcile(rows);
    const selected = rows[this.shell.state.selected]?.run;
    this.shell.ensureSelectionPane(selected !== undefined);
    const working = tree.runs.filter(
      (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
    ).length;
    const waiting = tree.runs.filter((run) => run.state === "waiting_for_parent").length;
    const paused = tree.runs.filter((run) => run.state === "paused").length;
    const hidden = tree.runs.length - rows.length;
    const titleRaw = ` /subagents · ${countLabel(tree.runs.length, "run")}${hidden ? ` · ${rows.length} visible` : ""}${working ? ` · ${working} running` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""} `;
    const title = clipToWidth(titleRaw, Math.max(0, safeWidth - 2), "");
    return framedScreen(this.frame, {
      width: safeWidth,
      height,
      top: this.options.theme.fg("accent", title),
      // The footer already fits inside the frame.
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
    const { theme } = this.options;
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
    return framedFill(this.frame, rows, height, inner);
  }

  /** One run's row; a name in `duplicates` also shows the run's short id. */
  private runLine(
    row: FleetTreeRow,
    index: number,
    width: number,
    duplicates: ReadonlySet<string>,
  ): string {
    const { theme } = this.options;
    const { run } = row;
    const now = this.options.getNow();
    const selected = index === this.shell.state.selected;
    const focused = selected && this.shell.state.pane === "list";
    const selection = selected ? theme.fg(focused ? "accent" : "muted", ">") : " ";
    const branch = theme.fg("dim", runTreeBranch(row));
    const disclosure = row.hasChildren ? theme.fg("muted", row.expanded ? "▾" : "▸") : " ";
    const glyph = theme.fg(runStateColor(run.state), runStateGlyph(run.state, spinnerFrameAt(now)));
    const age =
      run.state === "completed"
        ? ` ${formatRelativeAge(now - (run.endedAt ?? run.lastActivityAt))}`
        : "";
    const details = `${runStateLabel(run.state)}${age} · ${run.writeIntent}${run.openaiFastMode ? " · ⚡ fast" : ""}`;
    const identity = duplicates.has(run.name) ? `[${shortRunId(run.id)}] ${run.name}` : run.name;
    const label = focused
      ? focusedField(theme, sanitizeTerminalLine(`${identity} · ${details}`))
      : theme.fg(managerTone.identity, sanitizeTerminalLine(identity)) +
        theme.fg("muted", ` · ${sanitizeTerminalLine(details)}`);
    return padListDetailRow(`${selection} ${branch}${disclosure} ${glyph} ${label}`, width);
  }

  private listPane(
    rows: ReadonlyArray<FleetTreeRow>,
    limit: number,
    width: number,
    duplicates: ReadonlySet<string>,
  ): string[] {
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    const { start, end } = this.shell.visibleWindow(rows.length, limit);
    const visible = rows.slice(start, end).map((row, offset) => ({ row, index: start + offset }));
    const pane = this.shell.state.pane === "list";
    return [
      listDetailHeading(this.options.theme, this.listHeading(rows, visible), pane),
      ...visible.map(({ row, index }) => this.runLine(row, index, width, duplicates)),
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

  private keyLabel(id: FullScreenSelectionKeybindingId, fallback: string): string {
    const withoutTreeArrows = configuredKeyLabels(this.options.keybindingLabel, FLEET_SHORTCUTS)
      .key(id, fallback)
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
    const { actions, compactActions } = fleetActionLabels(selected);
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

  /** The list and detail panes in the current layout; the list window is always taken first. */
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
    this.options.onDispose?.();
  }
}
