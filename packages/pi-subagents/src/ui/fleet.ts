import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { isActiveRunState, type SubagentProjection, type SubagentRunView } from "../run/model.ts";
import { sanitizeTerminalLine, sanitizeTerminalText } from "./sanitize.ts";

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
  private pendingStop: string | undefined;
  private readonly options: FleetOptions;

  constructor(options: FleetOptions) {
    this.options = options;
  }

  private reconcile(runs: ReadonlyArray<SubagentRunView>): void {
    const existing = this.selectedId ? runs.findIndex((run) => run.id === this.selectedId) : -1;
    this.selected =
      existing >= 0 ? existing : Math.min(this.selected, Math.max(0, runs.length - 1));
    this.selectedId = runs[this.selected]?.id;
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
    if (matchesKey(data, Key.up) || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.selectedId = runs[this.selected]?.id;
    } else if (matchesKey(data, Key.down) || data === "j") {
      this.selected = Math.min(Math.max(0, runs.length - 1), this.selected + 1);
      this.selectedId = runs[this.selected]?.id;
    } else if (matchesKey(data, Key.enter)) {
      this.details = !this.details;
    } else if (data === "x" && selected) {
      if (this.pendingStop === selected.id) {
        this.pendingStop = undefined;
        this.options.actions.stop(selected.id);
      } else this.pendingStop = selected.id;
    } else if (
      data === "i" &&
      selected &&
      (selected.state === "running" || selected.state === "waiting_for_parent")
    ) {
      this.options.actions.interrupt(selected.id);
    } else if (
      data === "r" &&
      selected &&
      (selected.state === "paused" || selected.state === "completed")
    ) {
      this.options.actions.resume(selected.id);
    } else if (data === "m" && selected && isActiveRunState(selected.state)) {
      this.options.actions.message(selected.id, selected.state === "waiting_for_parent");
    } else if (data === "n" && selected) {
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
    const help = this.pendingStop
      ? ` press x again to stop ${this.pendingStop} · esc cancel `
      : " ↑↓/jk select  enter details  m message  i interrupt  r resume  n rename  x stop  esc close ";
    const bottom = `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(help) - 2))}${help}╯`;
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
    const label = sanitizeTerminalLine(
      `${run.name} · ${run.id} · ${run.state} · ${run.writeIntent}`,
    );
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

  private detailLines(run: SubagentRunView | undefined): string[] {
    if (!run) return [this.options.theme.fg("dim", "No subagents in this parent session.")];
    const header = this.options.theme.fg(
      "accent",
      sanitizeTerminalLine(`${run.name} · ${run.state}`),
    );
    const metadata = this.options.theme.fg(
      "dim",
      sanitizeTerminalLine(
        `${run.model}:${run.effort} · ${run.context} · ${run.execution}${run.currentTool ? ` · tool ${run.currentTool}` : ""}`,
      ),
    );
    const notices = [
      run.question
        ? this.options.theme.fg(
            "warning",
            `Question: ${sanitizeTerminalLine(run.question.message)}`,
          )
        : undefined,
      run.progress
        ? this.options.theme.fg("muted", `Progress: ${sanitizeTerminalLine(run.progress)}`)
        : undefined,
      run.warning
        ? this.options.theme.fg("warning", `Warning: ${sanitizeTerminalLine(run.warning)}`)
        : undefined,
      run.error
        ? this.options.theme.fg("error", `Error: ${sanitizeTerminalLine(run.error)}`)
        : undefined,
    ].filter((line): line is string => line !== undefined);
    const transcript = run.transcript.flatMap((line) => sanitizeTerminalText(line).split("\n"));
    return [
      header,
      metadata,
      ...(this.details
        ? [
            this.options.theme.fg("dim", sanitizeTerminalLine(run.task)),
            ...(run.sessionFile
              ? [this.options.theme.fg("dim", sanitizeTerminalLine(run.sessionFile))]
              : []),
          ]
        : []),
      ...notices,
      "",
      ...(transcript.length ? transcript : [this.options.theme.fg("dim", "(no transcript yet)")]),
    ];
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
    const detail = this.detailLines(selected);
    const start = Math.max(0, detail.length - height);
    return Array.from(
      { length: height },
      (_, index) =>
        `│${pad(left[index] ?? "", leftWidth)}│${pad(detail[start + index] ?? "", rightWidth)}│`,
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
    const detail = this.detailLines(selected);
    const start = Math.max(0, detail.length - remaining);
    const lines = [
      ...list.map((line) => `│${pad(line, inner)}│`),
      divider,
      ...detail.slice(start, start + remaining).map((line) => `│${pad(line, inner)}│`),
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
        ? this.detailLines(selected)
        : runs.length
          ? this.visibleRuns(runs, height).map(({ run, index }) => this.runLine(run, index, inner))
          : [this.options.theme.fg("dim", "No subagents.")];
    const start = Math.max(0, lines.length - height);
    const rendered = lines.slice(start, start + height).map((line) => `│${pad(line, inner)}│`);
    while (rendered.length < height) rendered.push(`│${" ".repeat(inner)}│`);
    return rendered;
  }

  invalidate(): void {}
}
