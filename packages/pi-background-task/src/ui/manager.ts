import { focusedField, managerTone } from "pi-cosmic-ui/manager/style";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderResponsiveManagerFooter, clipToWidth, spinnerFrameAt } from "pi-cosmic-ui/manager";
import { configuredKeyLabels } from "pi-cosmic-ui/manager/key-labels";
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
  framedScreen,
  framedStackedRows,
  framedWideRows,
  listDetailFrame,
  listDetailHeading,
  detailFieldRows,
  ListDetailShell,
  type ListDetailFrame,
} from "pi-cosmic-ui/manager/list-detail-shell";
import type {
  BackgroundTaskView,
  BackgroundLogEvent,
  BackgroundTaskProjection,
} from "../task/model.ts";
import { countTaskStates, isActiveTaskState } from "../task/model.ts";
import { sanitizeTerminalLine, formatElapsed, formatBytes, countLabel } from "pi-cosmic-core";
import { styledBackgroundLogLines } from "./styled-log.ts";
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

const duration = (task: BackgroundTaskView, now: number): string =>
  formatElapsed((task.endedAt ?? now) - task.startedAt);

export class TaskManagerComponent implements Component {
  private follow = true;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  /** Stop and clear wait for their own key again, or Enter. */
  private pending:
    | { readonly action: "stop"; readonly id: string }
    | { readonly action: "clear" }
    | undefined;
  private readonly shell = new ListDetailShell();
  private readonly options: TaskManagerOptions;

  constructor(options: TaskManagerOptions) {
    this.options = options;
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
        tasks.map((task) => task.id),
      ),
    );
  }

  private reconcileSelection(tasks: ReadonlyArray<BackgroundTaskView>): void {
    this.applySelection(this.shell.reconcile(tasks.map((task) => task.id)));
    const selected = tasks[this.shell.state.selected];
    if (
      this.pending?.action === "stop"
        ? this.pending.id !== selected?.id || !isActiveTaskState(selected.state)
        : this.pending?.action === "clear" && !tasks.some((task) => !isActiveTaskState(task.state))
    )
      this.pending = undefined;
  }

  handleInput(data: string): void {
    const tasks = this.options.getProjection().tasks;
    this.reconcileSelection(tasks);
    const selected = tasks[this.shell.state.selected];
    const matchesKeybinding = this.options.matchesKeybinding;

    if (this.pending) {
      const pending = this.pending;
      const key = pending.action === "stop" ? "x" : "c";
      const resolution = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set([key]),
      });
      const hasStableTarget = pending.action === "clear" || selected?.id === pending.id;
      const confirmed =
        hasStableTarget &&
        ((resolution?._tag === "Action" && resolution.action === "confirm") ||
          confirmedReservedShortcut(resolution, data, key));
      if (confirmed) {
        this.pending = undefined;
        if (pending.action === "clear") this.options.clear();
        else if (selected) this.options.stop(selected.id);
      } else if (
        !hasStableTarget ||
        (resolution?._tag === "Action" && resolution.action === "cancel")
      )
        this.pending = undefined;
      this.options.requestRender();
      return;
    }

    const resolution = this.shell.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding,
      reservedKeys: TASK_MANAGER_SHORTCUTS,
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      if (resolution.key === "t") {
        this.showTechnicalDetails = !this.showTechnicalDetails;
        this.shell.resetDetailScroll();
        this.follow = true;
      } else if (resolution.key === "f" && selected && isActiveTaskState(selected.state)) {
        // Unfollow is sticky: the anchored detail window keeps the viewed slice even before
        // overflow; toggling follow back on returns to the newest lines.
        this.follow = !this.follow;
        this.shell.resetDetailScroll();
      } else if (resolution.key === "x" && selected && isActiveTaskState(selected.state)) {
        this.pending = { action: "stop", id: selected.id };
      } else if (resolution.key === "c" && tasks.some((task) => !isActiveTaskState(task.state)))
        this.pending = { action: "clear" };
      this.options.requestRender();
      return;
    }

    if (resolution.action === "confirm") {
      if (selected)
        this.shell.applyMotion("forward", { rowCount: tasks.length, hasSelection: true });
      this.options.requestRender();
      return;
    }
    if (resolution.action === "help") this.alternateHelp = !this.alternateHelp;
    const motion = listDetailMotionFromAction(resolution.action);
    if (motion) {
      const result = this.shell.applyMotion(motion, {
        rowCount: tasks.length,
        hasSelection: selected !== undefined,
      });
      if (result._tag === "Close") {
        this.options.close();
        return;
      }
      if (result._tag === "Update") {
        // Scrolling away from the newest lines detaches follow; an explicit unfollow stays
        // sticky, so scrolling back to the bottom never silently re-follows.
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
        this.shell.state.layout === "wide"
          ? this.renderWide(safeWidth, bodyHeight, tasks, selected)
          : this.shell.state.layout === "stacked"
            ? this.renderStacked(safeWidth, bodyHeight, tasks, selected)
            : this.renderNarrow(safeWidth, bodyHeight, tasks, selected),
    });
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
        [
          this.pending.action === "clear"
            ? `c Confirm clearing ${countLabel(tasks.filter((task) => !isActiveTaskState(task.state)).length, "finished task")}`
            : `x Confirm stop ${selected?.id === this.pending.id ? taskDisplayName(selected) : "the selected task"}`,
          `${escape}/q Cancel`,
        ],
      ]);
    const actions = [
      selected && isActiveTaskState(selected.state)
        ? `f ${this.follow ? "Unfollow" : "Follow"}`
        : undefined,
      selected && isActiveTaskState(selected.state) ? "x Stop" : undefined,
      tasks.some((task) => !isActiveTaskState(task.state)) ? "c Clear finished" : undefined,
    ].filter((item): item is string => item !== undefined);
    const joinedActions = actions.length > 0 ? actions.join(" · ") : undefined;
    // The expanded ? overlay is the discoverable place for the full motion vocabulary.
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
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    const { start, end } = this.shell.visibleWindow(tasks.length, limit);
    return tasks.slice(start, end).map((task, offset) => ({ task, index: start + offset }));
  }

  // Caches fully sanitized, prefixed, themed lines per immutable log snapshot so a render tick
  // over unchanged events skips reassembly of the whole detail pane.
  private renderedLogLines = new WeakMap<
    ReadonlyArray<BackgroundLogEvent>,
    ReadonlyArray<string>
  >();

  private logLines(events: ReadonlyArray<BackgroundLogEvent>): ReadonlyArray<string> {
    const cached = this.renderedLogLines.get(events);
    if (cached) return cached;
    const rendered = styledBackgroundLogLines(events).map(({ stream, text }) => {
      const prefix = stream === "stderr" ? this.options.theme.fg("error", "│ ") : "│ ";
      return `${prefix}${text}`;
    });
    this.renderedLogLines.set(events, rendered);
    return rendered;
  }

  private detailLines(task: BackgroundTaskView | undefined): string[] {
    if (!task) return [this.options.theme.fg("dim", "No background tasks yet")];
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
    if (task.droppedLogBytes > 0)
      lines.push(
        this.options.theme.fg(
          "warning",
          `… ${formatBytes(task.droppedLogBytes)} of older output removed`,
        ),
      );
    const beforeLogs = lines.length;
    for (const line of this.logLines(task.logs)) lines.push(line);
    if (lines.length === beforeLogs) lines.push(this.options.theme.fg("dim", "No output yet"));
    return lines;
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
    const window = this.shell.detailWindow(wrapped, height, this.follow);
    if (!window.overflow) return [...window.visible];
    return [
      this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow)),
      ...window.visible,
    ].map((line) => clipToWidth(line, width, ""));
  }

  private listPane(
    tasks: ReadonlyArray<BackgroundTaskView>,
    limit: number,
    width: number,
  ): string[] {
    return [
      listDetailHeading(this.options.theme, "Background tasks", this.shell.state.pane === "list"),
      ...this.visibleTasks(tasks, limit).map(({ task, index }) =>
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
    const right = this.detailWindow(this.detailLines(selected), height, detailWidth);
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
    const detail = this.detailWindow(this.detailLines(selected), remaining, inner);
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
        ? this.detailWindow(this.detailLines(selected), height, inner)
        : tasks.length
          ? this.visibleTasks(tasks, height).map(({ task, index }) =>
              this.taskLine(task, index, inner),
            )
          : [this.options.theme.fg("dim", "No background tasks yet")];
    // Keep the hidden inspector's line count so unfollow stays anchored when reopened.
    return framedFill(this.frame, lines, height, inner, this.shell.state.pane);
  }

  invalidate(): void {
    this.renderedLogLines = new WeakMap();
  }
}
