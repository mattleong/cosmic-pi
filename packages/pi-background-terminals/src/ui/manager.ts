import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
  brailleSpinnerFrame,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
import {
  decodeFullScreenPrintable,
  FullScreenKeymap,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keybindings";
import type { BackgroundJobView, BackgroundTerminalProjection } from "../job/model.ts";
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
type ProcessManagerPane = "list" | "detail";

const PROCESS_MANAGER_SHORTCUTS = new Set(["c", "f", "t", "x"]);

const statePresentation = (job: BackgroundJobView, frame: number) => {
  switch (job.state) {
    case "starting":
      return { glyph: startingSpinnerFrame(frame), color: "accent", label: "starting…" } as const;
    case "running":
      return { glyph: brailleSpinnerFrame(frame), color: "success", label: "running" } as const;
    case "stopping":
      return { glyph: "◐", color: "warning", label: "stopping…" } as const;
    case "exited":
      return { glyph: "✓", color: "success", label: "finished" } as const;
    case "failed":
      return { glyph: "×", color: "error", label: "failed" } as const;
    case "stopped":
      return { glyph: "■", color: "muted", label: "stopped" } as const;
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

const padToWidth = (text: string, width: number) => {
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
};

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
  private pendingStop: string | undefined;
  private layout: ProcessManagerLayout = "narrow";
  private pane: ProcessManagerPane = "list";
  private readonly keymap = new FullScreenKeymap();
  private readonly options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.options = options;
  }

  private select(index: number, jobs: ReadonlyArray<BackgroundJobView>): void {
    const previousId = this.selectedId;
    this.selected = Math.max(0, Math.min(Math.max(0, jobs.length - 1), index));
    this.selectedId = jobs[this.selected]?.id;
    if (previousId !== this.selectedId) {
      this.follow = true;
      this.detailScroll = 0;
      this.pendingStop = undefined;
    }
  }

  private reconcileSelection(jobs: ReadonlyArray<BackgroundJobView>): void {
    const existing = this.selectedId ? jobs.findIndex((job) => job.id === this.selectedId) : -1;
    this.select(existing >= 0 ? existing : this.selected, jobs);
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
      const printable = decodeFullScreenPrintable(data);
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.pendingStop = undefined;
      } else if (
        resolution?._tag === "Shortcut" &&
        resolution.key === "x" &&
        printable === "x" &&
        selected?.id === this.pendingStop
      ) {
        this.pendingStop = undefined;
        this.options.stop(selected.id);
      } else this.pendingStop = undefined;
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
        this.follow = !this.follow;
        this.detailScroll = this.follow ? 0 : Math.min(this.detailMaxScroll, 1);
      } else if (resolution.key === "x" && selected && isActiveJobState(selected.state)) {
        this.pendingStop = selected.id;
      } else if (resolution.key === "c" && jobs.some((job) => !isActiveJobState(job.state)))
        this.options.clear();
      this.options.requestRender();
      return;
    }

    const browsingDetail = this.pane === "detail" || (this.layout === "narrow" && this.details);
    const pageSize = Math.max(1, this.detailPageSize);
    switch (resolution.action) {
      case "cancel":
      case "quit":
        this.options.close();
        return;
      case "back":
        if (browsingDetail) {
          this.pane = "list";
          this.details = false;
          this.keymap.resetChord();
        }
        break;
      case "forward":
        if (selected) {
          this.pane = "detail";
          if (this.layout === "narrow") this.details = true;
          this.keymap.resetChord();
        }
        break;
      case "confirm":
        if (this.layout === "narrow" && selected) {
          this.details = !this.details;
          this.pane = this.details ? "detail" : "list";
          this.detailScroll = 0;
          this.follow = true;
          this.keymap.resetChord();
        }
        break;
      case "up":
        if (browsingDetail) this.scrollDetail(1);
        else this.select(this.selected - 1, jobs);
        break;
      case "down":
        if (browsingDetail) this.scrollDetail(-1);
        else this.select(this.selected + 1, jobs);
        break;
      case "half-page-up": {
        const step = Math.max(1, Math.floor(pageSize / 2));
        if (browsingDetail) this.scrollDetail(step);
        else
          this.select(
            this.selected - Math.max(1, Math.floor((this.options.getHeight() - 3) / 2)),
            jobs,
          );
        break;
      }
      case "half-page-down": {
        const step = Math.max(1, Math.floor(pageSize / 2));
        if (browsingDetail) this.scrollDetail(-step);
        else
          this.select(
            this.selected + Math.max(1, Math.floor((this.options.getHeight() - 3) / 2)),
            jobs,
          );
        break;
      }
      case "first":
        if (browsingDetail) this.scrollDetail(this.detailMaxScroll);
        else this.select(0, jobs);
        break;
      case "last":
        if (browsingDetail) this.scrollDetail(-this.detailMaxScroll);
        else this.select(jobs.length - 1, jobs);
        break;
      case "help":
        this.alternateHelp = !this.alternateHelp;
        break;
      case "pending-first":
      case "search":
        break;
    }
    this.options.requestRender();
  }

  private scrollDetail(delta: number): void {
    this.follow = false;
    this.detailScroll = Math.max(0, Math.min(this.detailMaxScroll, this.detailScroll + delta));
    this.follow = this.detailScroll === 0;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    const nextLayout = safeWidth >= 100 ? "wide" : safeWidth >= 60 ? "stacked" : "narrow";
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
      this.options.keybindingLabel?.(id, fallback) || fallback;
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
    if (this.alternateHelp)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `${navigation} Move · h/l Panes · gg/G Ends`,
          actions.length > 0 ? actions.join(" · ") : "No actions",
          "? Back · q Close",
        ],
        [
          `${navigation} · h/l · gg/G`,
          actions.length > 0 ? actions.join(" · ") : "No actions",
          "? · q",
        ],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Move · C-u/d Scroll · h/l Panes`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        "t Technical · ? More · q Close",
      ],
      [
        `${navigation} · C-u/d · h/l`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        "t Tech · ? · q",
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
    return padToWidth(`${prefix} ${glyph} ${text}`, width);
  }

  private visibleJobs(
    jobs: ReadonlyArray<BackgroundJobView>,
    limit: number,
  ): ReadonlyArray<{ readonly job: BackgroundJobView; readonly index: number }> {
    const size = Math.max(1, limit);
    const start = Math.max(
      0,
      Math.min(Math.max(0, jobs.length - size), this.selected - Math.floor(size / 2)),
    );
    return jobs.slice(start, start + size).map((job, offset) => ({
      job,
      index: start + offset,
    }));
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
      const parts = sanitizeTerminalText(event.text).split("\n");
      for (const part of parts) if (part) lines.push(`${prefix}${part}`);
    }
    if (lines.length === (this.showTechnicalDetails ? 5 : 2))
      lines.push(this.options.theme.fg("dim", "(no output)"));
    return lines;
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    if (height <= 0) {
      this.detailMaxScroll = 0;
      this.detailPageSize = 1;
      return [];
    }
    if (this.follow) this.detailScroll = 0;
    const hasOverflow = lines.length > height;
    const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
    this.detailPageSize = Math.max(1, bodyHeight);
    if (!this.follow && this.detailScroll > 0 && lines.length > this.detailLineCount)
      this.detailScroll += lines.length - this.detailLineCount;
    this.detailLineCount = lines.length;
    this.detailMaxScroll = Math.max(0, lines.length - bodyHeight);
    this.detailScroll = Math.min(this.detailScroll, this.detailMaxScroll);
    const start = Math.max(0, lines.length - bodyHeight - this.detailScroll);
    const visible = lines.slice(start, start + bodyHeight);
    if (!hasOverflow) return visible;
    const end = Math.min(lines.length, start + bodyHeight);
    return [
      this.options.theme.fg("dim", ` ${start + 1}–${end} of ${lines.length} · C-u up · C-d down `),
      ...visible,
    ].map((line) => truncateToWidth(line, width, ""));
  }

  private renderWide(
    width: number,
    height: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string[] {
    const inner = width - 2;
    const leftWidth = Math.max(34, Math.floor(inner * 0.4));
    const rightWidth = inner - leftWidth - 1;
    const left = [
      this.options.theme.fg(
        this.pane === "list" ? "accent" : "muted",
        `${this.pane === "list" ? "› " : ""}Background jobs`,
      ),
      ...this.visibleJobs(jobs, Math.max(1, height - 1)).map(({ job, index }) =>
        this.jobLine(job, index, leftWidth),
      ),
    ];
    const detail = this.detailWindow(this.detailLines(selected), height, rightWidth);
    return Array.from(
      { length: height },
      (_, index) =>
        `${this.outerBorder("│")}${padToWidth(left[index] ?? "", leftWidth)}${this.innerBorder(
          "│",
        )}${padToWidth(detail[index] ?? "", rightWidth)}${this.outerBorder("│")}`,
    );
  }

  private renderStacked(
    width: number,
    height: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = Math.max(3, Math.min(jobs.length + 1, Math.floor(height * 0.4)));
    const list = [
      this.options.theme.fg(
        this.pane === "list" ? "accent" : "muted",
        `${this.pane === "list" ? "› " : ""}Background jobs`,
      ),
      ...this.visibleJobs(jobs, Math.max(1, listHeight - 1)).map(({ job, index }) =>
        this.jobLine(job, index, inner),
      ),
    ];
    const divider = `${this.outerBorder("├")}${this.innerBorder("─".repeat(inner))}${this.outerBorder("┤")}`;
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected), remaining, inner);
    const frame = (line: string) =>
      `${this.outerBorder("│")}${padToWidth(line, inner)}${this.outerBorder("│")}`;
    const content = [...list.map(frame), divider, ...detail.map(frame)];
    while (content.length < height) content.push(frame(""));
    return content.slice(0, height);
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
    const frame = (line: string) =>
      `${this.outerBorder("│")}${padToWidth(line, inner)}${this.outerBorder("│")}`;
    const rendered = lines.slice(0, height).map(frame);
    while (rendered.length < height) rendered.push(frame(""));
    return rendered;
  }

  invalidate(): void {}
}
