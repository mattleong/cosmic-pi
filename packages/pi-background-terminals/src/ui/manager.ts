import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { BackgroundJobView, BackgroundTerminalProjection } from "../job/model.ts";
import { isActiveJobState } from "../job/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./sanitize.ts";

export interface ProcessManagerOptions {
  readonly theme: Theme;
  readonly getProjection: () => BackgroundTerminalProjection;
  readonly getHeight: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly stop: (id: string) => void;
  readonly clear: () => void;
}

const stateGlyph = (job: BackgroundJobView) => {
  switch (job.state) {
    case "starting":
      return "◌";
    case "running":
      return "●";
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

const duration = (job: BackgroundJobView) => {
  if (job.endedAt === undefined) return "active";
  const seconds = Math.max(0, Math.floor((job.endedAt - job.startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${seconds % 60}s`;
};

const padToWidth = (text: string, width: number) => {
  const truncated = truncateToWidth(text, width, "");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
};

export class ProcessManagerComponent implements Component {
  private selected = 0;
  private selectedId: string | undefined;
  private follow = true;
  private details = false;
  private pendingStop: string | undefined;
  private readonly options: ProcessManagerOptions;

  constructor(options: ProcessManagerOptions) {
    this.options = options;
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
      return this.options.close();
    }
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.selectedId = jobs[this.selected]?.id;
      this.pendingStop = undefined;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(Math.max(0, jobs.length - 1), this.selected + 1);
      this.selectedId = jobs[this.selected]?.id;
      this.pendingStop = undefined;
    } else if (matchesKey(data, Key.enter)) {
      this.details = !this.details;
      this.pendingStop = undefined;
    } else if (data === "f" && selected && isActiveJobState(selected.state)) {
      this.follow = !this.follow;
      this.pendingStop = undefined;
    } else if (data === "x" && selected && isActiveJobState(selected.state)) {
      if (this.pendingStop === selected.id) {
        this.pendingStop = undefined;
        this.options.stop(selected.id);
      } else {
        this.pendingStop = selected.id;
      }
    } else if (data === "c") {
      this.pendingStop = undefined;
      this.options.clear();
    }
    this.options.requestRender();
  }

  private reconcileSelection(jobs: ReadonlyArray<BackgroundJobView>): void {
    const byId = this.selectedId ? jobs.findIndex((job) => job.id === this.selectedId) : -1;
    this.selected = byId >= 0 ? byId : Math.min(this.selected, Math.max(0, jobs.length - 1));
    this.selectedId = jobs[this.selected]?.id;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    const projection = this.options.getProjection();
    const jobs = projection.jobs;
    this.reconcileSelection(jobs);
    const selected = jobs[this.selected];
    const running = jobs.filter((job) => isActiveJobState(job.state)).length;
    const failed = jobs.filter((job) => job.state === "failed" || job.state === "timed_out").length;
    const title = ` /ps · ${running} running${failed ? ` · ${failed} failed` : ""} `;
    const top = `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`;
    const footerText = this.pendingStop
      ? ` press x again to stop ${this.pendingStop} · esc cancel `
      : ` ↑↓/jk select  enter details  f ${this.follow ? "unfollow" : "follow"}  x stop  c clear  esc close `;
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(footerText) - 2))}${footerText}╯`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    if (safeWidth === 1) return Array.from({ length: height }, () => " ");

    const bodyHeight = height - 2;
    let body: string[];
    if (safeWidth >= 100) body = this.renderWide(safeWidth, bodyHeight, jobs, selected);
    else if (safeWidth >= 60) body = this.renderStacked(safeWidth, bodyHeight, jobs, selected);
    else body = this.renderNarrow(safeWidth, bodyHeight, jobs, selected);
    return [truncateToWidth(top, safeWidth, ""), ...body, truncateToWidth(bottom, safeWidth, "")];
  }

  private jobLine(job: BackgroundJobView, index: number, width: number): string {
    const selected = index === this.selected;
    const color =
      job.state === "failed" || job.state === "timed_out"
        ? "error"
        : job.state === "exited"
          ? "success"
          : isActiveJobState(job.state)
            ? "accent"
            : "muted";
    const prefix = selected ? ">" : " ";
    const label = sanitizeTerminalLine(
      `${prefix} ${stateGlyph(job)} ${job.id} ${job.name ?? ""} ${job.state} ${duration(job)}`,
    );
    return padToWidth(this.options.theme.fg(color, label), width);
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

  private logLines(job: BackgroundJobView | undefined): string[] {
    if (!job) return [this.options.theme.fg("dim", "No background processes.")];
    const lines: string[] = [];
    if (job.droppedLogBytes > 0) {
      lines.push(
        this.options.theme.fg("warning", `… ${job.droppedLogBytes} earlier bytes discarded`),
      );
    }
    for (const event of job.logs) {
      const prefix = event.stream === "stderr" ? this.options.theme.fg("error", "│ ") : "│ ";
      const parts = sanitizeTerminalText(event.text).split("\n");
      for (const part of parts) if (part) lines.push(`${prefix}${part}`);
    }
    return lines.length > 0 ? lines : [this.options.theme.fg("dim", "(no output)")];
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
    const logs = this.logLines(selected);
    const logStart = this.follow ? Math.max(0, logs.length - Math.max(0, height - 3)) : 0;
    const lines = [
      this.options.theme.fg("accent", "Processes"),
      ...this.visibleJobs(jobs, Math.max(1, height - 1)).map(({ job, index }) =>
        this.jobLine(job, index, leftWidth),
      ),
    ];
    const details = selected
      ? [
          this.options.theme.fg(
            "accent",
            sanitizeTerminalLine(`${selected.id} · ${selected.name ?? selected.command}`),
          ),
          this.options.theme.fg(
            "dim",
            sanitizeTerminalLine(`${selected.cwd}${selected.pid ? ` · pid ${selected.pid}` : ""}`),
          ),
          ...(this.details
            ? [this.options.theme.fg("dim", sanitizeTerminalLine(selected.command))]
            : []),
          ...logs.slice(logStart),
        ]
      : logs;
    return Array.from({ length: height }, (_, index) => {
      const left = padToWidth(lines[index] ?? "", leftWidth);
      const right = padToWidth(details[index] ?? "", rightWidth);
      return `│${left}│${right}│`;
    });
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
      this.options.theme.fg("accent", "Processes"),
      ...this.visibleJobs(jobs, Math.max(1, listHeight - 1)).map(({ job, index }) =>
        this.jobLine(job, index, inner),
      ),
    ];
    const divider = this.options.theme.fg("borderMuted", `├${"─".repeat(Math.max(0, width - 2))}┤`);
    const logs = this.logLines(selected);
    const remaining = Math.max(0, height - list.length - 1);
    const start = this.follow ? Math.max(0, logs.length - remaining) : 0;
    const content = [...list.map((line) => `│${padToWidth(line, inner)}│`), divider];
    for (const line of logs.slice(start, start + remaining)) {
      content.push(`│${padToWidth(line, inner)}│`);
    }
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
        ? [
            this.options.theme.fg(
              "accent",
              sanitizeTerminalLine(`${selected.id} · ${selected.state}`),
            ),
            this.options.theme.fg("dim", sanitizeTerminalLine(selected.command)),
            this.options.theme.fg("dim", sanitizeTerminalLine(selected.cwd)),
            ...this.logLines(selected),
          ]
        : jobs.length
          ? this.visibleJobs(jobs, height).map(({ job, index }) => this.jobLine(job, index, inner))
          : [this.options.theme.fg("dim", "No background processes.")];
    const start = this.follow ? Math.max(0, lines.length - height) : 0;
    const rendered = lines
      .slice(start, start + height)
      .map((line) => `│${padToWidth(line, inner)}│`);
    while (rendered.length < height) rendered.push(`│${" ".repeat(inner)}│`);
    return rendered;
  }

  invalidate(): void {}
}
