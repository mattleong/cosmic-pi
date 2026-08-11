import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  brailleSpinnerFrame,
  managerLayoutTier,
  managerStateGlyph,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
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
import type {
  BackgroundJobView,
  BackgroundLogEvent,
  BackgroundTerminalProjection,
} from "../job/model.ts";
import { isActiveJobState } from "../job/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./sanitize.ts";

export interface ProcessManagerOptions {
  readonly theme: Theme;
  readonly getProjection: () => BackgroundTerminalProjection;
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

type ProcessManagerLayout = "wide" | "stacked" | "narrow";

const PROCESS_MANAGER_SHORTCUTS = new Set(["c", "f", "t", "x"]);

const statePresentation = (job: BackgroundJobView, frame: number) => {
  switch (job.state) {
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
      return { glyph: "⧖", color: "error", label: "timed out" } as const;
  }
};

const formatDuration = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
};

const duration = (job: BackgroundJobView, now: number): string =>
  formatDuration((job.endedAt ?? now) - job.startedAt);

const displayName = (job: BackgroundJobView): string =>
  sanitizeTerminalLine(job.name?.trim() || job.command);

export class ProcessManagerComponent implements Component {
  private selected = 0;
  private selectedId: string | undefined;
  private follow = true;
  private details = false;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private listPageSize = 1;
  private pendingStop: string | undefined;
  private layout: ProcessManagerLayout = "narrow";
  private pane: ListDetailPane = "list";
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  private applySelection(next: ReturnType<typeof selectListIndex>): void {
    this.selected = next.selected;
    this.selectedId = next.selectedId;
    if (next.changed) {
      this.follow = true;
      this.detailScroll = 0;
      this.pendingStop = undefined;
    }
  }

  private select(index: number, jobs: ReadonlyArray<BackgroundJobView>): void {
    this.applySelection(
      selectListIndex(
        { selected: this.selected, selectedId: this.selectedId },
        index,
        jobs.map((job) => job.id),
      ),
    );
  }

  private reconcileSelection(jobs: ReadonlyArray<BackgroundJobView>): void {
    this.applySelection(
      reconcileListSelection(
        { selected: this.selected, selectedId: this.selectedId },
        jobs.map((job) => job.id),
      ),
    );
    const selected = jobs[this.selected];
    if (
      this.pendingStop &&
      (this.pendingStop !== selected?.id || !isActiveJobState(selected.state))
    )
      this.pendingStop = undefined;
  }

  handleInput(data: string): void {
    const jobs = this.options.getProjection().jobs;
    this.reconcileSelection(jobs);
    const selected = jobs[this.selected];
    const matchesKeybinding = this.options.matchesKeybinding;

    if (this.pendingStop) {
      const resolution = this.keymap.resolve(data, {
        mode: "confirmation",
        matchesKeybinding,
        reservedKeys: new Set(["x"]),
      });
      const confirmed =
        confirmedReservedShortcut(resolution, data, "x") && selected?.id === this.pendingStop;
      this.pendingStop = undefined;
      if (confirmed && selected) this.options.stop(selected.id);
      this.options.requestRender();
      return;
    }

    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding,
      reservedKeys: PROCESS_MANAGER_SHORTCUTS,
    });
    if (!resolution) return;
    if (resolution._tag === "Shortcut") {
      if (resolution.key === "t") {
        this.showTechnicalDetails = !this.showTechnicalDetails;
        this.detailScroll = 0;
        this.follow = true;
      } else if (resolution.key === "f" && selected && isActiveJobState(selected.state)) {
        // Unfollow is sticky: the anchored detail window keeps the viewed slice even before
        // overflow; toggling follow back on returns to the newest lines.
        this.follow = !this.follow;
        this.detailScroll = 0;
      } else if (resolution.key === "x" && selected && isActiveJobState(selected.state)) {
        this.pendingStop = selected.id;
      } else if (resolution.key === "c" && jobs.some((job) => !isActiveJobState(job.state)))
        this.options.clear();
      this.options.requestRender();
      return;
    }

    if (resolution.action === "confirm") {
      if (this.layout === "narrow" && selected) {
        this.details = !this.details;
        this.pane = this.details ? "detail" : "list";
        this.detailScroll = 0;
        this.follow = true;
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
          rowCount: jobs.length,
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
        // Scrolling away from the newest lines detaches follow; an explicit unfollow stays
        // sticky, so scrolling back to the bottom never silently re-follows.
        if (result.scrolledDetail && this.detailScroll > 0) this.follow = false;
        if (result.movedSelection) this.select(result.state.selected, jobs);
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
    const jobs = projection.jobs;
    this.reconcileSelection(jobs);
    const selected = jobs[this.selected];
    if (!selected && this.pane === "detail") {
      this.pane = "list";
      this.details = false;
      this.keymap.resetChord();
    }
    const active = jobs.filter((job) => isActiveJobState(job.state)).length;
    const failed = jobs.filter((job) => job.state === "failed" || job.state === "timed_out").length;
    const title = ` /ps · ${active} active${failed ? ` · ${failed} failed` : ""} `;
    const top = `${this.outerBorder("╭")}${this.options.theme.fg("accent", title)}${this.outerBorder(
      `${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`,
    )}`;
    const footerText = this.helpText(safeWidth, jobs, selected);
    const bottom = `${this.outerBorder(
      `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(footerText) - 2))}`,
    )}${footerText}${this.outerBorder("╯")}`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    if (safeWidth === 1) return Array.from({ length: height }, () => " ");

    const bodyHeight = height - 2;
    const body =
      this.layout === "wide"
        ? this.renderWide(safeWidth, bodyHeight, jobs, selected)
        : this.layout === "stacked"
          ? this.renderStacked(safeWidth, bodyHeight, jobs, selected)
          : this.renderNarrow(safeWidth, bodyHeight, jobs, selected);
    return [truncateToWidth(top, safeWidth, ""), ...body, truncateToWidth(bottom, safeWidth, "")];
  }

  private outerBorder(text: string): string {
    return this.options.theme.fg("borderAccent", text);
  }

  private innerBorder(text: string): string {
    return this.options.theme.fg("borderMuted", text);
  }

  private helpText(
    width: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string {
    const contentWidth = Math.max(0, width - 2);
    const key = (id: FullScreenSelectionKeybindingId, fallback: string): string =>
      filterReservedKeyLabel(
        this.options.keybindingLabel?.(id, fallback) || fallback,
        PROCESS_MANAGER_SHORTCUTS,
        fallback,
      );
    const configuredNavigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : undefined;
    const navigation = configuredNavigation ? `j/k · ${configuredNavigation}` : "j/k";
    const escape = key("tui.select.cancel", "Esc");
    if (this.pendingStop)
      return renderResponsiveManagerFooter(contentWidth, [
        [`x Confirm stop ${this.pendingStop}`, `${escape}/q Cancel`],
      ]);
    const actions = [
      selected && isActiveJobState(selected.state)
        ? `f ${this.follow ? "Unfollow" : "Follow"}`
        : undefined,
      selected && isActiveJobState(selected.state) ? "x Stop" : undefined,
      jobs.some((job) => !isActiveJobState(job.state)) ? "c Clear" : undefined,
    ].filter((item): item is string => item !== undefined);
    // The expanded ? overlay is the discoverable place for the full motion vocabulary.
    if (this.alternateHelp)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `${navigation} Move · h/l Panes · C-u/d Half · PgUp/PgDn Page · gg/G Ends`,
          actions.length > 0 ? actions.join(" · ") : "No actions",
          `? Back · ${escape}/q Close`,
        ],
        [
          `${navigation} · h/l · C-u/d · PgUp/PgDn · gg/G`,
          actions.length > 0 ? actions.join(" · ") : "No actions",
          `? · ${escape}/q`,
        ],
        [`${navigation} · PgUp/PgDn · gg/G`, `? · ${escape}/q`],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Move · C-u/d Scroll · h/l Panes`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        `t Technical · ? More · ${escape}/q Close`,
      ],
      [
        `${navigation} · C-u/d · h/l`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        `t Tech · ? · ${escape}/q`,
      ],
      width >= 60
        ? [`${navigation} Select · h/l Panes`, "C-u/d · gg/G", `? More · ${escape}/q`]
        : [`${navigation} · l Details`, "gg/G", `? More · ${escape}/q`],
    ]);
  }

  private jobLine(job: BackgroundJobView, index: number, width: number): string {
    const selected = index === this.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
    const frame = Math.floor(this.options.getNow() / 160);
    const presentation = statePresentation(job, frame);
    const glyph = this.options.theme.fg(presentation.color, presentation.glyph);
    const label = sanitizeTerminalLine(
      `${displayName(job)} · ${presentation.label} · ${duration(job, this.options.getNow())}`,
    );
    const text = selected ? this.options.theme.fg("accent", label) : label;
    return padListDetailRow(`${prefix} ${glyph} ${text}`, width);
  }

  private visibleJobs(
    jobs: ReadonlyArray<BackgroundJobView>,
    limit: number,
  ): ReadonlyArray<{ readonly job: BackgroundJobView; readonly index: number }> {
    // The rendered window is the authoritative list page size for half/full-page motions,
    // so stacked layouts page by their actual visible rows rather than the full height.
    this.listPageSize = Math.max(1, limit);
    const start = listWindowStart(jobs.length, this.selected, limit);
    return jobs.slice(start, start + Math.max(1, limit)).map((job, offset) => ({
      job,
      index: start + offset,
    }));
  }

  private readonly sanitizedLogLines = new WeakMap<BackgroundLogEvent, ReadonlyArray<string>>();

  private logEventLines(event: BackgroundLogEvent): ReadonlyArray<string> {
    const cached = this.sanitizedLogLines.get(event);
    if (cached) return cached;
    const parts = sanitizeTerminalText(event.text).split("\n");
    this.sanitizedLogLines.set(event, parts);
    return parts;
  }

  private detailLines(job: BackgroundJobView | undefined): string[] {
    if (!job) return [this.options.theme.fg("dim", "No background jobs.")];
    const presentation = statePresentation(job, Math.floor(this.options.getNow() / 160));
    const lines = [
      this.options.theme.fg("accent", displayName(job)),
      this.options.theme.fg(
        presentation.color,
        `${presentation.label} · ${duration(job, this.options.getNow())}`,
      ),
    ];
    if (this.showTechnicalDetails) {
      lines.push(
        this.options.theme.fg("dim", `ID ${sanitizeTerminalLine(job.id)}`),
        this.options.theme.fg(
          "dim",
          sanitizeTerminalLine(`${job.cwd}${job.pid ? ` · pid ${job.pid}` : ""}`),
        ),
        this.options.theme.fg("dim", sanitizeTerminalLine(job.command)),
      );
    }
    if (job.droppedLogBytes > 0)
      lines.push(
        this.options.theme.fg("warning", `… ${job.droppedLogBytes} earlier bytes discarded`),
      );
    for (const event of job.logs) {
      const prefix = event.stream === "stderr" ? this.options.theme.fg("error", "│ ") : "│ ";
      for (const part of this.logEventLines(event)) if (part) lines.push(`${prefix}${part}`);
    }
    if (lines.length === (this.showTechnicalDetails ? 5 : 2))
      lines.push(this.options.theme.fg("dim", "(no output)"));
    return lines;
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    const window = computeDetailWindow({
      lines,
      height,
      previous: { scroll: this.detailScroll, lineCount: this.detailLineCount },
      follow: this.follow,
    });
    this.detailScroll = window.scroll;
    this.detailMaxScroll = window.maxScroll;
    this.detailPageSize = window.pageSize;
    this.detailLineCount = window.lineCount;
    if (!window.overflow) return [...window.visible];
    return [
      this.options.theme.fg("dim", detailWindowPositionLabel(window.overflow)),
      ...window.visible,
    ].map((line) => truncateToWidth(line, width, ""));
  }

  private frameLine(line: string, inner: number): string {
    return `${this.outerBorder("│")}${padListDetailRow(line, inner)}${this.outerBorder("│")}`;
  }

  private frameToHeight(rows: string[], height: number, inner: number): string[] {
    while (rows.length < height) rows.push(this.frameLine("", inner));
    return rows.slice(0, height);
  }

  private listPane(
    jobs: ReadonlyArray<BackgroundJobView>,
    limit: number,
    width: number,
  ): string[] {
    return [
      this.options.theme.fg(
        this.pane === "list" ? "accent" : "muted",
        `${this.pane === "list" ? "› " : ""}Background jobs`,
      ),
      ...this.visibleJobs(jobs, limit).map(({ job, index }) => this.jobLine(job, index, width)),
    ];
  }

  private renderWide(
    width: number,
    height: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string[] {
    const { listWidth: leftWidth, detailWidth: rightWidth } = wideListDetailGeometry(
      width,
      34,
      0.4,
    );
    const left = this.listPane(jobs, Math.max(1, height - 1), leftWidth);
    const detail = this.detailWindow(this.detailLines(selected), height, rightWidth);
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
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = stackedListHeight(height, jobs.length);
    const list = this.listPane(jobs, Math.max(1, listHeight - 1), inner);
    const divider = `${this.outerBorder("├")}${this.innerBorder("─".repeat(inner))}${this.outerBorder("┤")}`;
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected), remaining, inner);
    const frame = (line: string) => this.frameLine(line, inner);
    return this.frameToHeight([...list.map(frame), divider, ...detail.map(frame)], height, inner);
  }

  private renderNarrow(
    width: number,
    height: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.details && selected
        ? this.detailWindow(this.detailLines(selected), height, inner)
        : jobs.length
          ? this.visibleJobs(jobs, height).map(({ job, index }) => this.jobLine(job, index, inner))
          : [this.options.theme.fg("dim", "No background jobs.")];
    if (!this.details) {
      this.detailMaxScroll = 0;
      this.detailLineCount = 0;
    }
    return this.frameToHeight(
      lines.map((line) => this.frameLine(line, inner)),
      height,
      inner,
    );
  }

  invalidate(): void {}
}
