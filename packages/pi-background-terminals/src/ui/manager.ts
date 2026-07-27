import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  brailleSpinnerFrame,
  renderResponsiveManagerFooter,
  startingSpinnerFrame,
} from "pi-cosmic-ui/manager";
import type { BackgroundJobView, BackgroundTerminalProjection } from "../job/model.ts";
import { isActiveJobState } from "../job/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./sanitize.ts";

export interface ProcessManagerOptions {
  readonly theme: Theme;
  readonly getProjection: () => BackgroundTerminalProjection;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly stop: (id: string) => void;
  readonly clear: () => void;
}

type ProcessManagerLayout = "wide" | "stacked" | "narrow";

const stateGlyph = (job: BackgroundJobView, frame: number): string => {
  switch (job.state) {
    case "starting":
      return startingSpinnerFrame(frame);
    case "running":
      return brailleSpinnerFrame(frame);
    case "stopping":
      return "◐";
    case "exited":
      return "✓";
    case "failed":
      return "×";
    case "stopped":
      return "■";
    case "timed_out":
      return "⧖";
  }
};

const stateColor = (job: BackgroundJobView) => {
  switch (job.state) {
    case "starting":
      return "accent";
    case "running":
    case "exited":
      return "success";
    case "stopping":
      return "warning";
    case "failed":
    case "timed_out":
      return "error";
    case "stopped":
      return "muted";
  }
};

const stateLabel = (job: BackgroundJobView): string => {
  switch (job.state) {
    case "starting":
      return "starting…";
    case "running":
      return "running";
    case "stopping":
      return "stopping…";
    case "exited":
      return "finished";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    case "timed_out":
      return "timed out";
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
  private pendingStop: string | undefined;
  private layout: ProcessManagerLayout = "narrow";
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
    if (matchesKey(data, Key.escape)) {
      if (this.pendingStop) {
        this.pendingStop = undefined;
        this.options.requestRender();
        return;
      }
      this.options.close();
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.follow = false;
      this.detailScroll = Math.min(this.detailMaxScroll, this.detailScroll + 1);
    } else if (matchesKey(data, Key.ctrl("d"))) {
      this.detailScroll = Math.max(0, this.detailScroll - 1);
      this.follow = this.detailScroll === 0;
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.select(this.selected - 1, jobs);
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.select(this.selected + 1, jobs);
    } else if (matchesKey(data, Key.enter) && this.layout === "narrow") {
      this.details = !this.details;
      this.detailScroll = 0;
      this.follow = true;
    } else if (data === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.detailScroll = 0;
      this.follow = true;
    } else if (data === "?") {
      this.alternateHelp = !this.alternateHelp;
    } else if (data === "f" && selected && isActiveJobState(selected.state)) {
      this.follow = !this.follow;
      this.detailScroll = this.follow ? 0 : Math.min(this.detailMaxScroll, 1);
      this.pendingStop = undefined;
    } else if (data === "x" && selected && isActiveJobState(selected.state)) {
      if (this.pendingStop === selected.id) {
        this.pendingStop = undefined;
        this.options.stop(selected.id);
      } else this.pendingStop = selected.id;
    } else if (data === "c" && jobs.some((job) => !isActiveJobState(job.state))) {
      this.pendingStop = undefined;
      this.options.clear();
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.layout = safeWidth >= 100 ? "wide" : safeWidth >= 60 ? "stacked" : "narrow";
    const projection = this.options.getProjection();
    const jobs = projection.jobs;
    this.reconcileSelection(jobs);
    const selected = jobs[this.selected];
    const active = jobs.filter((job) => isActiveJobState(job.state)).length;
    const failed = jobs.filter((job) => job.state === "failed" || job.state === "timed_out").length;
    const title = ` /ps · ${active} active${failed ? ` · ${failed} failed` : ""} `;
    const top = `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`;
    const footerText = this.helpText(safeWidth, jobs, selected);
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(footerText) - 2))}${footerText}╯`;
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

  private helpText(
    width: number,
    jobs: ReadonlyArray<BackgroundJobView>,
    selected: BackgroundJobView | undefined,
  ): string {
    const contentWidth = Math.max(0, width - 2);
    if (this.pendingStop)
      return renderResponsiveManagerFooter(contentWidth, [
        [`x Confirm stop ${this.pendingStop}`, "Esc Cancel"],
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
        [actions.length > 0 ? actions.join(" · ") : "No actions", "? Keys"],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        "↑↓ Select · C-u/d Scroll",
        actions.length > 0 ? actions.join(" · ") : undefined,
        "t Technical · ? Help · Esc Close",
      ],
      ["↑↓ · C-u/d", actions.length > 0 ? actions.join(" · ") : undefined, "t Tech · ? Help · Esc"],
      width >= 60
        ? ["↑↓ Select · C-u/d", "t Details · ? Actions · Esc"]
        : ["↑↓ · Enter", "t", "? Actions · Esc"],
    ]);
  }

  private jobLine(job: BackgroundJobView, index: number, width: number): string {
    const selected = index === this.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
    const frame = Math.floor(this.options.getNow() / 160);
    const glyph = this.options.theme.fg(stateColor(job), stateGlyph(job, frame));
    const label = sanitizeTerminalLine(
      `${displayName(job)} · ${stateLabel(job)} · ${duration(job, this.options.getNow())}`,
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
    const lines = [
      this.options.theme.fg("accent", displayName(job)),
      this.options.theme.fg(
        stateColor(job),
        `${stateLabel(job)} · ${duration(job, this.options.getNow())}`,
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
      return [];
    }
    if (this.follow) this.detailScroll = 0;
    const hasOverflow = lines.length > height;
    const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
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
      this.options.theme.fg("accent", "Background jobs"),
      ...this.visibleJobs(jobs, Math.max(1, height - 1)).map(({ job, index }) =>
        this.jobLine(job, index, leftWidth),
      ),
    ];
    const detail = this.detailWindow(this.detailLines(selected), height, rightWidth);
    return Array.from(
      { length: height },
      (_, index) =>
        `│${padToWidth(left[index] ?? "", leftWidth)}│${padToWidth(detail[index] ?? "", rightWidth)}│`,
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
      this.options.theme.fg("accent", "Background jobs"),
      ...this.visibleJobs(jobs, Math.max(1, listHeight - 1)).map(({ job, index }) =>
        this.jobLine(job, index, inner),
      ),
    ];
    const divider = this.options.theme.fg("borderMuted", `├${"─".repeat(inner)}┤`);
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected), remaining, inner);
    const content = [
      ...list.map((line) => `│${padToWidth(line, inner)}│`),
      divider,
      ...detail.map((line) => `│${padToWidth(line, inner)}│`),
    ];
    while (content.length < height) content.push(`│${" ".repeat(inner)}│`);
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
    const rendered = lines.slice(0, height).map((line) => `│${padToWidth(line, inner)}│`);
    while (rendered.length < height) rendered.push(`│${" ".repeat(inner)}│`);
    return rendered;
  }

  invalidate(): void {}
}
