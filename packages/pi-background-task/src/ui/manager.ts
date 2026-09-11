import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import {
  brailleSpinnerFrame,
  managerStateGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
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
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { styledBackgroundLogLines } from "./styled-log.ts";

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

const statePresentation = (task: BackgroundTaskView, frame: number) => {
  switch (task.state) {
    case "starting":
      return { glyph: startingSpinnerFrame(frame), color: "accent", label: "starting…" } as const;
    case "running":
      return { glyph: brailleSpinnerFrame(frame), color: "success", label: "running" } as const;
    case "stopping":
      return {
        glyph: managerStateGlyph("stopping"),
        color: "warning",
        label: "stopping…",
      } as const;
    case "exited":
      return { glyph: managerStateGlyph("done"), color: "success", label: "finished" } as const;
    case "failed":
      return { glyph: managerStateGlyph("failed"), color: "error", label: "failed" } as const;
    case "stopped":
      return { glyph: managerStateGlyph("stopped"), color: "muted", label: "stopped" } as const;
    case "timed_out":
      return {
        glyph: managerStateGlyph("failed"),
        color: "error",
        label: "timed out",
      } as const;
  }
};

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
};

const duration = (task: BackgroundTaskView, now: number): string =>
  formatDuration((task.endedAt ?? now) - task.startedAt);

const displayName = (task: BackgroundTaskView): string =>
  sanitizeTerminalLine(task.name?.trim() || task.command);

export class TaskManagerComponent implements Component {
  private follow = true;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pendingStop: string | undefined;
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
      this.pendingStop = undefined;
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
      this.pendingStop &&
      (this.pendingStop !== selected?.id || !isActiveTaskState(selected.state))
    )
      this.pendingStop = undefined;
  }

  handleInput(data: string): void {
    const tasks = this.options.getProjection().tasks;
    this.reconcileSelection(tasks);
    const selected = tasks[this.shell.state.selected];
    const matchesKeybinding = this.options.matchesKeybinding;

    if (this.pendingStop) {
      const resolution = this.shell.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set(["x"]),
      });
      const hasStableTarget = selected?.id === this.pendingStop;
      const confirmed =
        hasStableTarget &&
        ((resolution?._tag === "Action" && resolution.action === "confirm") ||
          confirmedReservedShortcut(resolution, data, "x"));
      if (confirmed && selected) {
        this.pendingStop = undefined;
        this.options.stop(selected.id);
      } else if (
        !hasStableTarget ||
        (resolution?._tag === "Action" && resolution.action === "cancel")
      )
        this.pendingStop = undefined;
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
        this.pendingStop = selected.id;
      } else if (resolution.key === "c" && tasks.some((task) => !isActiveTaskState(task.state)))
        this.options.clear();
      this.options.requestRender();
      return;
    }

    if (resolution.action === "confirm") {
      // Enter policy stays local: only the narrow layout toggles the expanded inspector.
      if (this.shell.state.layout === "narrow" && selected) {
        this.shell.enterPane();
        this.follow = true;
      }
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
    const key = (id: FullScreenSelectionKeybindingId, fallback: string): string =>
      filterReservedKeyLabel(
        this.options.keybindingLabel?.(id, fallback) || fallback,
        TASK_MANAGER_SHORTCUTS,
        fallback,
      );
    const configuredNavigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : undefined;
    const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
    const escape = key("tui.select.cancel", "Esc");
    if (this.pendingStop)
      return renderResponsiveManagerFooter(contentWidth, [
        [`x Confirm stop ${sanitizeTerminalLine(this.pendingStop)}`, `${escape}/q Cancel`],
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
          `? Back · ${escape}/q Close`,
        ],
        [
          `${navigation} · h/l · C-u/d · PgUp/PgDn · gg/G`,
          joinedActions ?? "No actions",
          `? · ${escape}/q`,
        ],
        [`${navigation} · PgUp/PgDn · gg/G`, `? · ${escape}/q`],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Move · C-u/d Scroll · h/l Panes`,
        joinedActions,
        `t Technical · ? More · ${escape}/q Close`,
      ],
      [`${navigation} · C-u/d · h/l`, joinedActions, `t Tech · ? · ${escape}/q`],
      width >= 60
        ? [`${navigation} Select · h/l Panes`, "C-u/d · gg/G", `? More · ${escape}/q`]
        : [`${navigation} · l Details`, "gg/G", `? More · ${escape}/q`],
    ]);
  }

  private taskLine(task: BackgroundTaskView, index: number, width: number): string {
    const selected = index === this.shell.state.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
    const frame = Math.floor(this.options.getNow() / 160);
    const presentation = statePresentation(task, frame);
    const glyph = this.options.theme.fg(presentation.color, presentation.glyph);
    const label = sanitizeTerminalLine(
      `${displayName(task)} · ${presentation.label} · ${duration(task, this.options.getNow())}`,
    );
    const text = selected ? this.options.theme.fg("accent", label) : label;
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
    if (!task) return [this.options.theme.fg("dim", "No background tasks.")];
    const presentation = statePresentation(task, Math.floor(this.options.getNow() / 160));
    const lines = [
      listDetailHeading(this.options.theme, displayName(task), this.shell.state.pane === "detail"),
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
          { label: "ID", value: sanitizeTerminalLine(task.id) },
          {
            label: "Directory",
            value: sanitizeTerminalLine(`${task.cwd}${task.pid ? ` · pid ${task.pid}` : ""}`),
          },
          { label: "Command", value: sanitizeTerminalLine(task.command) },
        ]),
      );
    }
    if (task.droppedLogBytes > 0)
      lines.push(
        this.options.theme.fg("warning", `… ${task.droppedLogBytes} bytes of older output removed`),
      );
    const beforeLogs = lines.length;
    for (const line of this.logLines(task.logs)) lines.push(line);
    if (lines.length === beforeLogs) lines.push(this.options.theme.fg("dim", "(no output)"));
    return lines;
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    const window = this.shell.detailWindow(lines, height, this.follow);
    if (!window.overflow) return [...window.visible];
    return [
      this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow)),
      ...window.visible,
    ].map((line) => truncateToWidth(line, width, ""));
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
          : [this.options.theme.fg("dim", "No background tasks.")];
    if (!this.shell.state.details) this.shell.resetDetailWindow();
    return framedFill(this.frame, lines, height, inner);
  }

  invalidate(): void {
    this.renderedLogLines = new WeakMap();
  }
}
