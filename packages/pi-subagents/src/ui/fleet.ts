import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import {
  hasSubagentCapability,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import {
  formatRelativeAge,
  renderSubagentSessionOutput,
} from "../tools/renderers/session-output.ts";
import { sanitizeTerminalLine } from "./sanitize.ts";

export interface FleetActions {
  readonly stop: (id: string) => void;
  readonly interrupt: (id: string) => void;
  readonly resume: (id: string) => void;
  readonly message: (id: string, waiting: boolean) => void;
  readonly rename: (id: string) => void;
}

export interface FleetOptions {
  readonly theme: Theme;
  readonly getProjection: () => SubagentProjection;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly actions: FleetActions;
}

const stateGlyph = (run: SubagentRunView): string => {
  switch (run.state) {
    case "starting":
      return "◌";
    case "running":
      return "●";
    case "waiting_for_parent":
      return "?";
    case "paused":
      return "Ⅱ";
    case "completed":
      return "✓";
    case "failed":
      return "×";
    case "stopping":
      return "◐";
    case "stopped":
      return "■";
  }
};

const stateColor = (run: SubagentRunView) => {
  switch (run.state) {
    case "starting":
      return "accent";
    case "running":
    case "completed":
      return "success";
    case "waiting_for_parent":
    case "paused":
    case "stopping":
      return "warning";
    case "failed":
      return "error";
    case "stopped":
      return "muted";
  }
};

const pad = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
};

export class SubagentFleetComponent implements Component {
  private selected = 0;
  private selectedId: string | undefined;
  private details = false;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pendingStop: string | undefined;
  private readonly options: FleetOptions;

  constructor(options: FleetOptions) {
    this.options = options;
  }

  private reconcile(runs: ReadonlyArray<SubagentRunView>): void {
    const previousId = this.selectedId;
    const existing = this.selectedId ? runs.findIndex((run) => run.id === this.selectedId) : -1;
    this.selected =
      existing >= 0 ? existing : Math.min(this.selected, Math.max(0, runs.length - 1));
    this.selectedId = runs[this.selected]?.id;
    if (previousId !== undefined && previousId !== this.selectedId) this.detailScroll = 0;
  }

  handleInput(data: string): void {
    const runs = this.options.getProjection().runs;
    this.reconcile(runs);
    const selected = runs[this.selected];
    if (matchesKey(data, Key.escape)) {
      if (this.pendingStop) {
        this.pendingStop = undefined;
        this.options.requestRender();
        return;
      }
      this.options.close();
      return;
    }
    if (matchesKey(data, Key.ctrl("k"))) {
      this.detailScroll = Math.min(this.detailMaxScroll, this.detailScroll + 1);
    } else if (matchesKey(data, Key.ctrl("j"))) {
      this.detailScroll = Math.max(0, this.detailScroll - 1);
    } else if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.selectedId = runs[this.selected]?.id;
      this.detailScroll = 0;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
      this.selectedId = runs[this.selected]?.id;
      this.detailScroll = 0;
    } else if (matchesKey(data, Key.enter)) {
      this.details = !this.details;
      this.detailScroll = 0;
    } else if (data === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.detailScroll = 0;
    } else if (data === "?") {
      this.alternateHelp = !this.alternateHelp;
    } else if (data === "x" && selected) {
      if (this.pendingStop === selected.id) {
        this.pendingStop = undefined;
        this.options.actions.stop(selected.id);
      } else this.pendingStop = selected.id;
    } else if (
      data === "i" &&
      selected &&
      hasSubagentCapability(selected, "interrupt") &&
      (selected.state === "running" || selected.state === "waiting_for_parent")
    ) {
      this.options.actions.interrupt(selected.id);
    } else if (
      data === "r" &&
      selected &&
      hasSubagentCapability(selected, "resume") &&
      (selected.state === "paused" || selected.state === "completed")
    ) {
      this.options.actions.resume(selected.id);
    } else if (
      data === "m" &&
      selected &&
      ((selected.state === "running" && hasSubagentCapability(selected, "steer")) ||
        (selected.state === "waiting_for_parent" &&
          hasSubagentCapability(selected, "parent-contact")))
    ) {
      this.options.actions.message(selected.id, selected.state === "waiting_for_parent");
    } else if (
      data === "n" &&
      selected &&
      hasSubagentCapability(selected, "rename-display") &&
      selected.state !== "starting" &&
      selected.state !== "stopping" &&
      selected.state !== "stopped" &&
      selected.state !== "failed"
    ) {
      this.options.actions.rename(selected.id);
    }
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    const projection = this.options.getProjection();
    const runs = projection.runs;
    this.reconcile(runs);
    const selected = runs[this.selected];
    const active = runs.filter((run) => isActiveRunState(run.state)).length;
    const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
    const title = ` /subagents · ${active} active${waiting ? ` · ${waiting} waiting` : ""} `;
    const top = `╭${title}${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`;
    const help = this.helpText(safeWidth);
    const safeHelp = truncateToWidth(help, Math.max(0, safeWidth - 2), "");
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(safeHelp) - 2))}${safeHelp}╯`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    if (safeWidth === 1) return Array.from({ length: height }, () => " ");
    const bodyHeight = height - 2;
    const body =
      safeWidth >= 100
        ? this.renderWide(safeWidth, bodyHeight, runs, selected)
        : safeWidth >= 60
          ? this.renderStacked(safeWidth, bodyHeight, runs, selected)
          : this.renderNarrow(safeWidth, bodyHeight, runs, selected);
    return [truncateToWidth(top, safeWidth, ""), ...body, truncateToWidth(bottom, safeWidth, "")];
  }

  private runLine(run: SubagentRunView, index: number, width: number): string {
    const selected = index === this.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
    const glyph = this.options.theme.fg(stateColor(run), stateGlyph(run));
    const state =
      run.state === "completed"
        ? `completed ${formatRelativeAge(this.options.getNow() - (run.endedAt ?? run.lastActivityAt))}`
        : run.state;
    const label = sanitizeTerminalLine(`${run.name} · ${state} · ${run.writeIntent} · ${run.id}`);
    return pad(
      `${prefix} ${glyph} ${selected ? this.options.theme.fg("accent", label) : label}`,
      width,
    );
  }

  private visibleRuns(runs: ReadonlyArray<SubagentRunView>, limit: number) {
    const size = Math.max(1, limit);
    const start = Math.max(
      0,
      Math.min(Math.max(0, runs.length - size), this.selected - Math.floor(size / 2)),
    );
    return runs.slice(start, start + size).map((run, offset) => ({ run, index: start + offset }));
  }

  private helpText(width: number): string {
    if (this.pendingStop) return ` x confirm stop ${this.pendingStop} · esc cancel `;
    if (width >= 100)
      return " ↑↓/jk select · C-j/C-k scroll · enter details · t technical · m message · i interrupt · r resume · n rename · x stop · esc close ";
    if (width >= 60)
      return " jk select · C-j/C-k scroll · enter details · t tech · ? keys · esc close ";
    return this.alternateHelp
      ? " m msg · i int · r res · n name · x/esc "
      : " jk · C-j/C-k scroll · t · ? help ";
  }

  private detailLines(run: SubagentRunView | undefined, width: number): string[] {
    if (!run) return [this.options.theme.fg("dim", "No subagents in this parent session.")];
    return renderSubagentSessionOutput(run, this.options.theme, {
      now: this.options.getNow(),
      showTechnicalDetails: this.showTechnicalDetails,
    }).render(Math.max(1, width));
  }

  private detailWindow(lines: string[], height: number, width: number): string[] {
    if (height <= 0) {
      this.detailMaxScroll = 0;
      return [];
    }
    const hasOverflow = lines.length > height;
    const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
    if (this.detailScroll > 0 && lines.length > this.detailLineCount) {
      this.detailScroll += lines.length - this.detailLineCount;
    }
    this.detailLineCount = lines.length;
    this.detailMaxScroll = Math.max(0, lines.length - bodyHeight);
    this.detailScroll = Math.min(this.detailScroll, this.detailMaxScroll);
    const start = Math.max(0, lines.length - bodyHeight - this.detailScroll);
    const visible = lines.slice(start, start + bodyHeight);
    if (!hasOverflow) return visible;
    const end = Math.min(lines.length, start + bodyHeight);
    const position = this.options.theme.fg(
      "dim",
      ` ${start + 1}–${end} of ${lines.length} · C-k up · C-j down `,
    );
    return [pad(position, width), ...visible];
  }

  private renderWide(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const leftWidth = Math.max(38, Math.floor(inner * 0.42));
    const rightWidth = inner - leftWidth - 1;
    const left = [
      this.options.theme.fg("accent", "Subagents"),
      ...this.visibleRuns(runs, Math.max(1, height - 1)).map(({ run, index }) =>
        this.runLine(run, index, leftWidth),
      ),
    ];
    const detail = this.detailWindow(this.detailLines(selected, rightWidth), height, rightWidth);
    return Array.from(
      { length: height },
      (_, index) =>
        `│${pad(left[index] ?? "", leftWidth)}│${pad(detail[index] ?? "", rightWidth)}│`,
    );
  }

  private renderStacked(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const listHeight = Math.max(3, Math.min(runs.length + 1, Math.floor(height * 0.4)));
    const list = [
      this.options.theme.fg("accent", "Subagents"),
      ...this.visibleRuns(runs, listHeight - 1).map(({ run, index }) =>
        this.runLine(run, index, inner),
      ),
    ];
    const divider = this.options.theme.fg("borderMuted", `├${"─".repeat(inner)}┤`);
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    const lines = [
      ...list.map((line) => `│${pad(line, inner)}│`),
      divider,
      ...detail.map((line) => `│${pad(line, inner)}│`),
    ];
    while (lines.length < height) lines.push(`│${" ".repeat(inner)}│`);
    return lines.slice(0, height);
  }

  private renderNarrow(
    width: number,
    height: number,
    runs: ReadonlyArray<SubagentRunView>,
    selected: SubagentRunView | undefined,
  ): string[] {
    const inner = width - 2;
    const lines =
      this.details && selected
        ? this.detailWindow(this.detailLines(selected, inner), height, inner)
        : runs.length
          ? this.visibleRuns(runs, height).map(({ run, index }) => this.runLine(run, index, inner))
          : [this.options.theme.fg("dim", "No subagents.")];
    if (!this.details) {
      this.detailMaxScroll = 0;
      this.detailLineCount = 0;
    }
    const rendered = lines.slice(0, height).map((line) => `│${pad(line, inner)}│`);
    while (rendered.length < height) rendered.push(`│${" ".repeat(inner)}│`);
    return rendered;
  }

  invalidate(): void {}
}
