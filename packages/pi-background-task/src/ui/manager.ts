import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { exitStatusMeaning } from "pi-code-previews";
import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter, clipToWidth, spinnerFrameAt } from "pi-cosmic-ui/manager";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
import type {
  FullScreenAction,
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
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  listDetailHeading,
  detailFieldRows,
  ListDetailShell,
  type ListDetailField,
  type ListDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import type { BackgroundTaskView, BackgroundTaskProjection } from "../task/model.ts";
import { countTaskStates, isActiveTaskState } from "../task/model.ts";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import { formatElapsed, formatBytes, countLabel } from "pi-cosmic-core/display";
import { StyledLogRows } from "./styled-log.ts";
import { taskStatePresentation, taskDisplayName } from "./task-state.ts";

export interface TaskManagerOptions {
  readonly theme: Theme;
  readonly getProjection: () => BackgroundTaskProjection;
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
  readonly stop: (id: string) => void;
  readonly clear: () => void;
}

const TASK_MANAGER_SHORTCUTS = new Set(["c", "f", "t", "x"]);

type PendingTaskAction =
  | { readonly action: "stop"; readonly id: string }
  | { readonly action: "clear" };

const duration = (task: BackgroundTaskView, now: number): string =>
  formatElapsed((task.endedAt ?? now) - task.startedAt);

const withMeaning = (label: string, meaning: string | undefined) =>
  meaning ? `${label} (${meaning})` : label;

function exitValue(task: BackgroundTaskView): string | undefined {
  const parts = [
    ...(Predicate.isNumber(task.exitCode)
      ? [withMeaning(`code ${task.exitCode}`, exitStatusMeaning(task.exitCode))]
      : []),
    ...(task.signal
      ? [withMeaning(`signal ${task.signal}`, exitStatusMeaning(undefined, task.signal))]
      : []),
  ];
  if (parts.length > 0) return sanitizeTerminalLine(Arr.join(parts, " · "));
  return task.exitCode === null ? "unknown" : undefined;
}

// Finished tasks explain their ending; the spawn error and output cause are often the only clue.
function outcomeFields(task: BackgroundTaskView): ListDetailField[] {
  if (isActiveTaskState(task.state)) return [];
  const exit = exitValue(task);
  const error = task.error && sanitizeTerminalLine(task.error);
  const cause = task.failureCause && sanitizeTerminalLine(task.failureCause);
  return [
    ...(exit ? [{ label: "Exit", value: exit, tone: managerTone.value }] : []),
    ...(error ? [{ label: "Error", value: error, tone: "error" as const }] : []),
    ...(cause ? [{ label: "Cause", value: cause, tone: "error" as const }] : []),
  ];
}

export class TaskManagerComponent implements Component {
  private follow = true;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pending: PendingTaskAction | undefined;
  private readonly shell = new ListDetailShell();
  private readonly options: TaskManagerOptions;
  private logRows: StyledLogRows;

  constructor(options: TaskManagerOptions) {
    this.options = options;
    this.logRows = this.makeLogRows();
  }

  private get frame(): ListDetailFrame {
    return listDetailFrame(this.options.theme, this.shell.state.pane);
  }

  private applySelection(next: ListSelectionChange): void {
    if (next.changed) {
      this.follow = true;
      if (this.pending?.action === "stop") this.pending = undefined;
    }
  }

  private select(index: number, tasks: ReadonlyArray<BackgroundTaskView>): void {
    this.applySelection(
      this.shell.select(
        index,
        Arr.map(tasks, (task) => task.id),
      ),
    );
  }

  private reconcileSelection(tasks: ReadonlyArray<BackgroundTaskView>): void {
    this.applySelection(this.shell.reconcile(Arr.map(tasks, (task) => task.id)));
    const selected = tasks[this.shell.state.selected];
    if (
      this.pending?.action === "stop"
        ? this.pending.id !== selected?.id || !isActiveTaskState(selected.state)
        : this.pending?.action === "clear" &&
          !Arr.some(tasks, (task) => !isActiveTaskState(task.state))
    )
      this.pending = undefined;
  }

  handleInput(data: string): void {
    const tasks = this.options.getProjection().tasks;
    this.reconcileSelection(tasks);
    const selected = tasks[this.shell.state.selected];
    if (this.pending) {
      this.handleConfirmation(data, this.pending, selected);
      this.options.requestRender();
      return;
    }
    const resolution = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: TASK_MANAGER_SHORTCUTS,
    });
    if (!resolution) return;
    Match.valueTags(resolution, {
      Action: ({ action }) => this.handleAction(action, tasks, selected),
      Shortcut: ({ key }) => {
        this.handleShortcut(key, tasks, selected);
        this.options.requestRender();
      },
    });
  }

  private handleConfirmation(
    data: string,
    pending: PendingTaskAction,
    selected: BackgroundTaskView | undefined,
  ): void {
    const key = pending.action === "stop" ? "x" : "c";
    const resolution = this.shell.keymap.resolve(data, {
      mode: "confirmation",
      matchesKeybinding: this.options.matchesKeybinding,
      reservedKeys: new Set([key]),
    });
    const hasStableTarget = pending.action === "clear" || selected?.id === pending.id;
    const confirmed =
      hasStableTarget &&
      ((Predicate.isTagged(resolution, "Action") && resolution.action === "confirm") ||
        confirmedReservedShortcut(resolution, data, key));
    if (confirmed) {
      this.pending = undefined;
      if (pending.action === "clear") this.options.clear();
      else if (selected) this.options.stop(selected.id);
    } else if (
      !hasStableTarget ||
      (Predicate.isTagged(resolution, "Action") && resolution.action === "cancel")
    )
      this.pending = undefined;
  }

  private handleShortcut(
    key: string,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): void {
    const active = selected !== undefined && isActiveTaskState(selected.state);
    if (key === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.shell.resetDetailScroll();
      this.follow = true;
    } else if (key === "f" && active) {
      this.follow = !this.follow;
      this.shell.resetDetailScroll();
    } else if (key === "x" && active) {
      this.pending = { action: "stop", id: selected.id };
    } else if (key === "c" && Arr.some(tasks, (task) => !isActiveTaskState(task.state)))
      this.pending = { action: "clear" };
  }

  private handleAction(
    action: FullScreenAction,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): void {
    if (action === "confirm") {
      if (selected)
        this.shell.applyMotion("forward", { rowCount: tasks.length, hasSelection: true });
      this.options.requestRender();
      return;
    }
    if (action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(action);
    if (motion) {
      const result = this.shell.applyMotion(motion, {
        rowCount: tasks.length,
        hasSelection: selected !== undefined,
      });
      if (Predicate.isTagged(result, "Close")) {
        this.options.close();
        return;
      }
      if (Predicate.isTagged(result, "Update")) {
        if (result.scrolledDetail && this.shell.state.detailScroll > 0) this.follow = false;
        if (result.movedSelection) this.select(result.state.selected, tasks);
      }
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.shell.syncLayout(safeWidth);
    const projection = this.options.getProjection();
    const tasks = projection.tasks;
    this.reconcileSelection(tasks);
    const selected = tasks[this.shell.state.selected];
    this.shell.ensureSelectionPane(selected !== undefined);
    const { active, failed } = countTaskStates(tasks);
    const title = ` /tasks · ${active} active${failed ? ` · ${failed} failed` : ""} `;
    const footerText = this.helpText(safeWidth, tasks, selected);
    return framedScreen(this.frame, {
      width: safeWidth,
      height,
      top: this.options.theme.fg("accent", title),
      bottom: footerText,
      body: (bodyHeight) =>
        Match.value(this.shell.state.layout).pipe(
          Match.when("wide", () => this.renderWide(safeWidth, bodyHeight, tasks, selected)),
          Match.when("stacked", () => this.renderStacked(safeWidth, bodyHeight, tasks, selected)),
          Match.when("narrow", () => this.renderNarrow(safeWidth, bodyHeight, tasks, selected)),
          Match.exhaustive,
        ),
    });
  }

  private confirmationLabel(
    pending: PendingTaskAction,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string {
    if (pending.action === "clear")
      return `c Confirm clearing ${countLabel(Arr.filter(tasks, (task) => !isActiveTaskState(task.state)).length, "finished task")}`;
    return `x Confirm stop ${selected?.id === pending.id ? taskDisplayName(selected) : "the selected task"}`;
  }

  private actionLabels(
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string[] {
    const active = selected !== undefined && isActiveTaskState(selected.state);
    return Arr.filter(
      [
        active ? `f ${this.follow ? "Unfollow" : "Follow"}` : undefined,
        active ? "x Stop" : undefined,
        Arr.some(tasks, (task) => !isActiveTaskState(task.state)) ? "c Clear finished" : undefined,
      ],
      Predicate.isString,
    );
  }

  private helpText(
    width: number,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string {
    const contentWidth = Math.max(0, width - 2);
    const { key, navigation } = configuredKeyLabels(
      this.options.keybindingLabel,
      TASK_MANAGER_SHORTCUTS,
    );
    const escape = key("tui.select.cancel", "Esc");
    const inspect = `${key("tui.select.confirm", "Enter")} Inspect`;
    const back =
      this.shell.state.pane === "detail" ? `${escape} Back · q Close` : `${escape}/q Close`;
    if (this.pending)
      return renderResponsiveManagerFooter(contentWidth, [
        [this.confirmationLabel(this.pending, tasks, selected), `${escape}/q Cancel`],
      ]);
    const actions = this.actionLabels(tasks, selected);
    const joinedActions = actions.length > 0 ? Arr.join(actions, " · ") : undefined;
    if (this.alternateHelp)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `${navigation} Move · h/l Panes · C-u/d Half · PgUp/PgDn Page · gg/G Ends`,
          joinedActions ?? "No actions",
          `? Back · ${back}`,
        ],
        [
          `${navigation} · h/l · C-u/d · PgUp/PgDn · gg/G`,
          joinedActions ?? "No actions",
          `? · ${back}`,
        ],
        [`${navigation} · PgUp/PgDn · gg/G`, `? · ${back}`],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Move · ${inspect} · h/l Panes`,
        joinedActions,
        `t Technical · ? More · ${back}`,
      ],
      [`${navigation} · ${inspect}`, joinedActions, `t Tech · ? · ${back}`],
      [inspect, "t Tech · ?", back],
    ]);
  }

  private taskLine(task: BackgroundTaskView, index: number, width: number): string {
    const selected = index === this.shell.state.selected;
    const prefix = selected
      ? this.options.theme.fg(this.shell.state.pane === "list" ? "accent" : "muted", ">")
      : " ";
    const frame = spinnerFrameAt(this.options.getNow());
    const presentation = taskStatePresentation(task.state, frame);
    const glyph = this.options.theme.fg(presentation.color, presentation.glyph);
    const identity = taskDisplayName(task);
    const text =
      (selected && this.shell.state.pane === "list"
        ? focusedField(this.options.theme, identity)
        : this.options.theme.fg(managerTone.identity, identity)) +
      this.options.theme.fg(presentation.color, ` · ${presentation.label}`) +
      this.options.theme.fg("muted", ` · ${duration(task, this.options.getNow())}`);
    return padListDetailRow(`${prefix} ${glyph} ${text}`, width);
  }

  private visibleTasks(
    tasks: ReadonlyArray<BackgroundTaskView>,
    limit: number,
  ): ReadonlyArray<{ readonly task: BackgroundTaskView; readonly index: number }> {
    const { start, end } = this.shell.visibleWindow(tasks.length, limit);
    return Arr.map(tasks.slice(start, end), (task, offset) => ({ task, index: start + offset }));
  }

  private makeLogRows(): StyledLogRows {
    return new StyledLogRows({ stdout: "│ ", stderr: this.options.theme.fg("error", "│ ") });
  }

  /** Detail rows wrapped to `width`; log rows come wrapped from a cache kept across renders. */
  private detailLines(task: BackgroundTaskView | undefined, width: number): string[] {
    const wrap = (lines: string[]) =>
      Arr.flatMap(lines, (line) => wrapTextWithAnsi(line, Math.max(1, width)));
    if (!task) return wrap([this.options.theme.fg("dim", "No background tasks yet")]);
    const presentation = taskStatePresentation(task.state, spinnerFrameAt(this.options.getNow()));
    const lines = [
      listDetailHeading(
        this.options.theme,
        taskDisplayName(task),
        this.shell.state.pane === "detail",
        managerTone.identity,
      ),
      ...detailFieldRows(this.options.theme, [
        {
          label: "Status",
          value: `${presentation.label} · ${duration(task, this.options.getNow())}`,
          tone: presentation.color,
        },
        ...outcomeFields(task),
      ]),
    ];
    if (this.showTechnicalDetails) {
      lines.push(
        ...detailFieldRows(this.options.theme, [
          { label: "ID", value: sanitizeTerminalLine(task.id), tone: managerTone.identity },
          {
            label: "Directory",
            tone: managerTone.value,
            value: sanitizeTerminalLine(`${task.cwd}${task.pid ? ` · pid ${task.pid}` : ""}`),
          },
          { label: "Command", value: sanitizeTerminalLine(task.command), tone: managerTone.value },
        ]),
      );
    }
    const logs = this.logRows.rows(`${task.id}:${task.startedAt}`, task.logs, width);
    const removed = formatBytes(task.droppedLogBytes);
    // Output can be removed entirely, in which case the task did print but none is kept.
    if (task.droppedLogBytes > 0)
      lines.push(
        this.options.theme.fg(
          "warning",
          logs.length > 0
            ? `… ${removed} of older output removed`
            : `${removed} of output removed; none is retained`,
        ),
      );
    else if (logs.length === 0)
      lines.push(
        this.options.theme.fg("dim", isActiveTaskState(task.state) ? "No output yet" : "No output"),
      );
    return [...wrap(lines), ...logs];
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    const window = this.shell.detailWindow(lines, height, this.follow);
    if (!window.overflow) return [...window.visible];
    return Arr.map(
      [this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow)), ...window.visible],
      (line) => clipToWidth(line, width, ""),
    );
  }

  private listPane(
    tasks: ReadonlyArray<BackgroundTaskView>,
    limit: number,
    width: number,
  ): string[] {
    return [
      listDetailHeading(this.options.theme, "Background tasks", this.shell.state.pane === "list"),
      ...Arr.map(this.visibleTasks(tasks, limit), ({ task, index }) =>
        this.taskLine(task, index, width),
      ),
    ];
  }

  private renderWide(
    width: number,
    height: number,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string[] {
    const { listWidth, detailWidth } = wideListDetailGeometry(width, 34, 0.4);
    const left = this.listPane(tasks, Math.max(1, height - 1), listWidth);
    const right = this.detailWindow(this.detailLines(selected, detailWidth), height, detailWidth);
    return framedWideRows(this.frame, { left, right, height, listWidth, detailWidth });
  }

  private renderStacked(
    width: number,
    height: number,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = stackedListHeight(height, tasks.length);
    const list = this.listPane(tasks, Math.max(1, listHeight - 1), inner);
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    return framedStackedRows(this.frame, { list, detail, height, inner });
  }

  private renderNarrow(
    width: number,
    height: number,
    tasks: ReadonlyArray<BackgroundTaskView>,
    selected: BackgroundTaskView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.shell.state.details && selected
        ? this.detailWindow(this.detailLines(selected, inner), height, inner)
        : tasks.length
          ? Arr.map(this.visibleTasks(tasks, height), ({ task, index }) =>
              this.taskLine(task, index, inner),
            )
          : [this.options.theme.fg("dim", "No background tasks yet")];
    return framedFill(this.frame, lines, height, inner, this.shell.state.pane);
  }

  invalidate(): void {
    this.logRows = this.makeLogRows();
  }
}
