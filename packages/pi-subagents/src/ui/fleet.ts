import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderResponsiveManagerFooter } from "pi-cosmic-ui/manager";
import {
  decodeKittyPrintable,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  hasSubagentCapability,
  isActiveRunState,
  type SubagentProjection,
  type SubagentRunView,
} from "../run/model.ts";
import { formatRelativeAge, renderSubagentSessionOutput } from "./session-output.ts";
import { animatedRunStateGlyph, runStateColor, runStateLabel } from "./run-state.ts";
import { sanitizeTerminalLine } from "./sanitize.ts";

export type FleetMessageMode = "guidance" | "reply" | "next-assignment";

export interface FleetActions {
  readonly stop: (id: string) => Promise<void>;
  readonly interrupt: (id: string) => Promise<void>;
  readonly resume: (id: string, message?: string) => Promise<void>;
  readonly message: (id: string, mode: FleetMessageMode, message: string) => Promise<void>;
  readonly rename: (id: string, name: string) => Promise<void>;
}

export type FleetKeybindingId =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel";

export interface FleetOptions {
  readonly theme: Theme;
  readonly getProjection: () => SubagentProjection;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly matchesKeybinding?: ((data: string, id: FleetKeybindingId) => boolean) | undefined;
  readonly keybindingLabel?: ((id: FleetKeybindingId, fallback: string) => string) | undefined;
  readonly requestRender: () => void;
  readonly close: () => void;
  readonly actions: FleetActions;
}

const canMessage = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    (((run.state === "running" || run.state === "reported") &&
      hasSubagentCapability(run, "steer")) ||
      (run.state === "waiting_for_parent" && hasSubagentCapability(run, "parent-contact"))),
  );
const canInterrupt = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "interrupt") &&
    (run.state === "running" || run.state === "waiting_for_parent"),
  );
const canResume = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "resume") &&
    (run.state === "paused" || run.state === "completed"),
  );
const canRename = (run: SubagentRunView | undefined): boolean =>
  Boolean(
    run &&
    hasSubagentCapability(run, "rename-display") &&
    run.state !== "starting" &&
    run.state !== "stopping" &&
    run.state !== "stopped" &&
    run.state !== "failed",
  );
const canStop = (run: SubagentRunView | undefined): boolean =>
  Boolean(run && isActiveRunState(run.state) && run.state !== "stopping");

type FleetLayout = "wide" | "stacked" | "narrow";
type FleetPromptKind = "guidance" | "reply" | "next-assignment" | "resume" | "rename";
type FleetNotice = { readonly kind: "info" | "success" | "error"; readonly text: string };
type FleetPrompt = {
  readonly kind: FleetPromptKind;
  readonly runId: string;
  readonly runName: string;
  readonly input: Input;
  readonly context?: string | undefined;
  feedback?: string | undefined;
};

const pad = (text: string, width: number): string => {
  const clipped = truncateToWidth(text, Math.max(0, width));
  return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
};

export class SubagentFleetComponent implements Component {
  private selected = 0;
  private selectedId: string | undefined;
  private details = false;
  private detailScroll = 0;
  private detailMaxScroll = 0;
  private detailLineCount = 0;
  private detailPageSize = 1;
  private showTechnicalDetails = false;
  private alternateHelp = false;
  private pendingStop: string | undefined;
  private prompt: FleetPrompt | undefined;
  private notice: FleetNotice | undefined;
  private busyAction: string | undefined;
  private layout: FleetLayout = "narrow";
  private readonly options: FleetOptions;

  constructor(options: FleetOptions) {
    this.options = options;
  }

  private select(index: number, runs: ReadonlyArray<SubagentRunView>): void {
    const previousId = this.selectedId;
    this.selected = Math.max(0, Math.min(Math.max(0, runs.length - 1), index));
    this.selectedId = runs[this.selected]?.id;
    if (previousId !== this.selectedId) {
      this.detailScroll = 0;
      this.pendingStop = undefined;
    }
  }

  private reconcile(runs: ReadonlyArray<SubagentRunView>): void {
    const existing = this.selectedId ? runs.findIndex((run) => run.id === this.selectedId) : -1;
    this.select(existing >= 0 ? existing : this.selected, runs);
    const selected = runs[this.selected];
    if (this.pendingStop && (this.pendingStop !== selected?.id || !canStop(selected)))
      this.pendingStop = undefined;
    if (this.prompt && this.prompt.runId !== selected?.id) this.prompt = undefined;
  }

  private printableKey(data: string): string | undefined {
    return data.length === 1 ? data : decodeKittyPrintable(data);
  }

  private openPrompt(run: SubagentRunView, kind: FleetPromptKind): void {
    const input = new Input();
    input.focused = true;
    this.prompt = {
      kind,
      runId: run.id,
      runName: sanitizeTerminalLine(run.name),
      input,
      ...(kind === "reply" && run.question?.message
        ? { context: sanitizeTerminalLine(run.question.message) }
        : {}),
    };
    this.notice = undefined;
  }

  private performAction(progress: string, success: string, operation: () => Promise<void>): void {
    this.busyAction = progress;
    this.notice = { kind: "info", text: progress };
    this.options.requestRender();
    let result: Promise<void>;
    try {
      result = operation();
    } catch (error) {
      result = Promise.reject(error);
    }
    void Promise.resolve(result).then(
      () => {
        this.busyAction = undefined;
        this.notice = { kind: "success", text: success };
        this.options.requestRender();
      },
      (error: unknown) => {
        this.busyAction = undefined;
        this.notice = {
          kind: "error",
          text: error instanceof Error ? error.message : "Subagent operation failed.",
        };
        this.options.requestRender();
      },
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
    const verb =
      mode === "reply"
        ? "Sending reply"
        : mode === "next-assignment"
          ? "Starting next assignment"
          : "Sending guidance";
    const success =
      mode === "reply"
        ? `Reply sent to ${name}.`
        : mode === "next-assignment"
          ? `Next assignment sent to ${name}.`
          : `Guidance sent to ${name}.`;
    this.performAction(`${verb}…`, success, () =>
      this.options.actions.message(prompt.runId, mode, message),
    );
  }

  handleInput(data: string): void {
    const runs = this.options.getProjection().runs;
    this.reconcile(runs);
    const selected = runs[this.selected];
    const configured = (
      id: FleetKeybindingId,
      fallback: Parameters<typeof matchesKey>[1],
    ): boolean =>
      this.options.matchesKeybinding
        ? this.options.matchesKeybinding(data, id)
        : matchesKey(data, fallback);
    const cancel = configured("tui.select.cancel", Key.escape);
    if (cancel) {
      if (this.prompt) {
        this.prompt = undefined;
        this.notice = { kind: "info", text: "Input canceled." };
        this.options.requestRender();
        return;
      }
      if (this.pendingStop) {
        this.pendingStop = undefined;
        this.notice = { kind: "info", text: "Stop canceled." };
        this.options.requestRender();
        return;
      }
      if (this.layout === "narrow" && this.details) {
        this.details = false;
        this.detailScroll = 0;
        this.options.requestRender();
        return;
      }
      this.options.close();
      return;
    }
    if (this.busyAction) return;
    if (this.prompt) {
      if (configured("tui.select.confirm", Key.enter)) this.submitPrompt();
      else {
        this.prompt.feedback = undefined;
        this.prompt.input.handleInput(data);
        this.options.requestRender();
      }
      return;
    }

    const printable = this.printableKey(data);
    if (this.pendingStop) {
      const run = selected && this.pendingStop === selected.id ? selected : undefined;
      this.pendingStop = undefined;
      if (printable === "x" && run && canStop(run))
        this.performAction(
          `Stopping ${sanitizeTerminalLine(run.name)}…`,
          `Stopped ${sanitizeTerminalLine(run.name)}.`,
          () => this.options.actions.stop(run.id),
        );
      else {
        this.notice = { kind: "info", text: "Stop canceled." };
        this.options.requestRender();
      }
      return;
    }
    this.notice = undefined;

    const halfPage = Math.max(1, Math.floor(this.detailPageSize / 2));
    const pageUp = configured("tui.select.pageUp", Key.pageUp);
    const pageDown = configured("tui.select.pageDown", Key.pageDown);
    const halfUp = matchesKey(data, Key.ctrl("u"));
    const halfDown = matchesKey(data, Key.ctrl("d"));
    const browsingNarrowList = this.layout === "narrow" && !this.details;
    if (halfUp || pageUp) {
      const step = pageUp ? this.detailPageSize : halfPage;
      if (browsingNarrowList)
        this.select(this.selected - Math.max(1, this.options.getHeight() - 3), runs);
      else this.detailScroll = Math.min(this.detailMaxScroll, this.detailScroll + step);
    } else if (halfDown || pageDown) {
      const step = pageDown ? this.detailPageSize : halfPage;
      if (browsingNarrowList)
        this.select(this.selected + Math.max(1, this.options.getHeight() - 3), runs);
      else this.detailScroll = Math.max(0, this.detailScroll - step);
    } else if (browsingNarrowList && matchesKey(data, Key.home)) this.select(0, runs);
    else if (browsingNarrowList && matchesKey(data, Key.end)) this.select(runs.length - 1, runs);
    else if (configured("tui.select.up", Key.up) || printable === "k")
      this.select(this.selected - 1, runs);
    else if (configured("tui.select.down", Key.down) || printable === "j")
      this.select(this.selected + 1, runs);
    else if (configured("tui.select.confirm", Key.enter) && this.layout === "narrow") {
      this.details = !this.details;
      this.detailScroll = 0;
    } else if (printable === "t") {
      this.showTechnicalDetails = !this.showTechnicalDetails;
      this.detailScroll = 0;
    } else if (printable === "?") this.alternateHelp = !this.alternateHelp;
    else if (printable === "x" && selected && canStop(selected)) this.pendingStop = selected.id;
    else if (printable === "i" && selected && canInterrupt(selected))
      this.performAction(
        `Interrupting ${sanitizeTerminalLine(selected.name)}…`,
        `Interrupted ${sanitizeTerminalLine(selected.name)}.`,
        () => this.options.actions.interrupt(selected.id),
      );
    else if (printable === "r" && selected && canResume(selected))
      this.openPrompt(selected, "resume");
    else if (printable === "m" && selected && canMessage(selected))
      this.openPrompt(
        selected,
        selected.state === "waiting_for_parent"
          ? "reply"
          : selected.state === "reported"
            ? "next-assignment"
            : "guidance",
      );
    else if (printable === "n" && selected && canRename(selected))
      this.openPrompt(selected, "rename");
    this.options.requestRender();
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, Math.floor(width));
    const height = Math.max(0, Math.floor(this.options.getHeight()));
    if (safeWidth === 0 || height === 0) return [];
    this.layout = safeWidth >= 100 ? "wide" : safeWidth >= 60 ? "stacked" : "narrow";
    const projection = this.options.getProjection();
    const runs = projection.runs;
    this.reconcile(runs);
    const selected = runs[this.selected];
    const working = runs.filter(
      (run) => run.state === "starting" || run.state === "running" || run.state === "stopping",
    ).length;
    const waiting = runs.filter((run) => run.state === "waiting_for_parent").length;
    const paused = runs.filter((run) => run.state === "paused").length;
    const retained = runs.filter((run) => run.state === "reported").length;
    const titleRaw = ` /subagents · ${runs.length} run${runs.length === 1 ? "" : "s"}${working ? ` · ${working} working` : ""}${waiting ? ` · ${waiting} waiting` : ""}${paused ? ` · ${paused} paused` : ""}${retained ? ` · ${retained} retained` : ""} `;
    const title = truncateToWidth(titleRaw, Math.max(0, safeWidth - 2), "");
    const top = `${this.outerBorder("╭")}${this.options.theme.fg("accent", title)}${this.outerBorder(
      `${"─".repeat(Math.max(0, safeWidth - visibleWidth(title) - 2))}╮`,
    )}`;
    const help = this.helpText(safeWidth, selected);
    const safeHelp = truncateToWidth(help, Math.max(0, safeWidth - 2), "");
    const bottom = `${this.outerBorder(
      `╰${"─".repeat(Math.max(0, safeWidth - visibleWidth(safeHelp) - 2))}`,
    )}${safeHelp}${this.outerBorder("╯")}`;
    if (height === 1) return [truncateToWidth(top, safeWidth, "")];
    if (safeWidth === 1) return Array.from({ length: height }, () => " ");
    const bodyHeight = height - 2;
    let body: string[];
    if (this.prompt) body = this.renderPrompt(safeWidth, bodyHeight, this.prompt);
    else {
      const showNotice = this.notice !== undefined && bodyHeight > 0;
      const contentHeight = Math.max(0, bodyHeight - (showNotice ? 1 : 0));
      const content =
        safeWidth >= 100
          ? this.renderWide(safeWidth, contentHeight, runs, selected)
          : safeWidth >= 60
            ? this.renderStacked(safeWidth, contentHeight, runs, selected)
            : this.renderNarrow(safeWidth, contentHeight, runs, selected);
      body = showNotice ? [this.renderNotice(safeWidth, this.notice!), ...content] : content;
    }
    return [truncateToWidth(top, safeWidth, ""), ...body, truncateToWidth(bottom, safeWidth, "")];
  }

  private outerBorder(text: string): string {
    return this.options.theme.fg("borderAccent", text);
  }

  private innerBorder(text: string): string {
    return this.options.theme.fg("borderMuted", text);
  }

  private renderNotice(width: number, notice: FleetNotice): string {
    const inner = Math.max(0, width - 2);
    const glyph = notice.kind === "error" ? "×" : notice.kind === "success" ? "✓" : "ℹ";
    const color =
      notice.kind === "error" ? "error" : notice.kind === "success" ? "success" : "muted";
    return `${this.outerBorder("│")}${pad(
      this.options.theme.fg(color, `${glyph} ${sanitizeTerminalLine(notice.text)}`),
      inner,
    )}${this.outerBorder("│")}`;
  }

  private renderPrompt(width: number, height: number, prompt: FleetPrompt): string[] {
    const inner = Math.max(0, width - 2);
    const title =
      prompt.kind === "reply"
        ? `Reply to ${prompt.runName}`
        : prompt.kind === "next-assignment"
          ? `Next assignment for ${prompt.runName}`
          : prompt.kind === "guidance"
            ? `Guide ${prompt.runName}`
            : prompt.kind === "resume"
              ? `Resume ${prompt.runName}`
              : `Rename ${prompt.runName}`;
    const instruction =
      prompt.kind === "reply"
        ? "Answer the pending question"
        : prompt.kind === "next-assignment"
          ? "Describe the next assignment"
          : prompt.kind === "guidance"
            ? "Enter guidance for the active assignment"
            : prompt.kind === "resume"
              ? "Optional continuation message; submit blank to resume"
              : "Enter a new display name";
    const inputLines = prompt.input.render(Math.max(1, inner)).slice(0, 1);
    const feedback = prompt.feedback ? [this.options.theme.fg("warning", prompt.feedback)] : [];
    const contextLines = prompt.context
      ? wrapTextWithAnsi(
          this.options.theme.fg("warning", `Question: ${prompt.context}`),
          Math.max(1, inner),
        )
      : [];
    const rows =
      height <= 1
        ? inputLines
        : height === 2
          ? [
              ...inputLines,
              ...(feedback.length > 0 ? feedback : [this.options.theme.fg("dim", instruction)]),
            ]
          : height === 3 && feedback.length > 0
            ? [
                this.options.theme.fg("accent", this.options.theme.bold(title)),
                ...inputLines,
                ...feedback,
              ]
            : [
                this.options.theme.fg("accent", this.options.theme.bold(title)),
                ...contextLines.slice(0, Math.max(0, height - 3 - feedback.length)),
                this.options.theme.fg("dim", instruction),
                ...inputLines,
                ...feedback,
              ];
    const frame = (line: string) =>
      `${this.outerBorder("│")}${pad(line, inner)}${this.outerBorder("│")}`;
    const rendered = rows.slice(0, height).map(frame);
    while (rendered.length < height) rendered.push(frame(""));
    return rendered;
  }

  private runLine(
    run: SubagentRunView,
    index: number,
    width: number,
    runs: ReadonlyArray<SubagentRunView>,
  ): string {
    const selected = index === this.selected;
    const prefix = selected ? this.options.theme.fg("accent", ">") : " ";
    const frame = Math.floor(this.options.getNow() / 160);
    const glyph = this.options.theme.fg(
      runStateColor(run.state),
      animatedRunStateGlyph(run.state, frame),
    );
    const state =
      run.state === "completed"
        ? `finished ${formatRelativeAge(this.options.getNow() - (run.endedAt ?? run.lastActivityAt))}`
        : run.state === "reported"
          ? `report ${run.reportGeneration} · retained`
          : runStateLabel(run.state);
    const duplicateName = runs.some(
      (candidate) => candidate.id !== run.id && candidate.name === run.name,
    );
    const shortId = run.id.length <= 14 ? run.id : `…${run.id.slice(-13)}`;
    const identity = duplicateName ? `[${shortId}] ${run.name}` : run.name;
    const label = sanitizeTerminalLine(
      `${identity} · ${state} · ${run.writeIntent}${run.fastMode ? " · ⚡ fast" : ""}`,
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

  private listHeading(
    runs: ReadonlyArray<SubagentRunView>,
    visible: ReadonlyArray<{ readonly index: number }>,
  ): string {
    if (runs.length === 0) return "Subagents · none";
    const start = (visible[0]?.index ?? 0) + 1;
    const end = (visible.at(-1)?.index ?? 0) + 1;
    return `Subagents · ${start}–${end} of ${runs.length}${start > 1 ? " · ↑ more" : ""}${end < runs.length ? " · ↓ more" : ""}`;
  }

  private helpText(width: number, selected: SubagentRunView | undefined): string {
    const contentWidth = Math.max(0, width - 2);
    const key = (id: FleetKeybindingId, fallback: string): string =>
      this.options.keybindingLabel?.(id, fallback) || fallback;
    const navigation = this.options.keybindingLabel
      ? `${key("tui.select.up", "↑")}/${key("tui.select.down", "↓")}`
      : "↑↓";
    const enter = key("tui.select.confirm", "Enter");
    const escape = key("tui.select.cancel", "Esc");
    const pages = `${key("tui.select.pageUp", "PgUp")}/${key("tui.select.pageDown", "PgDn")}`;
    if (this.prompt)
      return renderResponsiveManagerFooter(contentWidth, [[`${enter} Submit`, `${escape} Cancel`]]);
    if (this.busyAction)
      return renderResponsiveManagerFooter(contentWidth, [[this.busyAction, `${escape} Close`]]);
    if (this.pendingStop)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `x Confirm stop ${sanitizeTerminalLine(selected?.name ?? "selected subagent")}`,
          `${escape} Cancel`,
        ],
      ]);
    const messageAction = !canMessage(selected)
      ? undefined
      : selected?.state === "waiting_for_parent"
        ? "m Reply"
        : selected?.state === "reported"
          ? "m New task"
          : "m Guide";
    if (!selected)
      return renderResponsiveManagerFooter(contentWidth, [[`No runs · ? More`, `${escape} Close`]]);
    const actions = [
      messageAction,
      canInterrupt(selected) ? "i Interrupt" : undefined,
      canResume(selected) ? "r Resume" : undefined,
      canRename(selected) ? "n Rename" : undefined,
      canStop(selected) ? "x Stop" : undefined,
    ].filter((item): item is string => item !== undefined);
    const compactActions = [
      messageAction,
      canInterrupt(selected) ? "i Int" : undefined,
      canResume(selected) ? "r Resume" : undefined,
      canRename(selected) ? "n Name" : undefined,
      canStop(selected) ? "x Stop" : undefined,
    ].filter((item): item is string => item !== undefined);
    const scrollHelp =
      this.layout === "narrow" && !this.details
        ? `${pages} Page list · Home/End`
        : `C-u/d Half-page · ${pages} Page detail`;
    if (this.alternateHelp)
      return renderResponsiveManagerFooter(contentWidth, [
        [
          `${navigation} Select · ${enter} Details (narrow) · ${scrollHelp}`,
          compactActions.length > 0 ? compactActions.join(" · ") : "No run actions",
          `t Technical · ? Back · ${escape} Close`,
        ],
        [
          `${navigation} · ${enter} Details · ${scrollHelp}`,
          compactActions.length > 0 ? compactActions.join(" · ") : "No actions",
          `t Technical · ? Back · ${escape}`,
        ],
        [
          compactActions.length > 0 ? compactActions.join(" · ") : "No actions",
          `? Back · ${escape}`,
        ],
      ]);
    return renderResponsiveManagerFooter(contentWidth, [
      [
        `${navigation} Select · ${scrollHelp}`,
        actions.length > 0 ? actions.join(" · ") : undefined,
        `t Technical · ? More · ${escape} Close`,
      ],
      [
        `${navigation} · ${scrollHelp}`,
        compactActions.length > 0 ? compactActions.join(" · ") : undefined,
        `t Technical · ? More · ${escape}`,
      ],
      width >= 60
        ? [
            `${navigation} · ${pages}`,
            compactActions.length > 0 ? compactActions.join(" · ") : undefined,
            `? More · ${escape}`,
          ]
        : [`${navigation} · ${enter}`, `? More · ${escape}`],
    ]);
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
      this.detailPageSize = 1;
      return [];
    }
    const hasOverflow = lines.length > height;
    const bodyHeight = hasOverflow && height > 1 ? height - 1 : height;
    this.detailPageSize = Math.max(1, bodyHeight);
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
    const pageUp = this.options.keybindingLabel?.("tui.select.pageUp", "PgUp") || "PgUp";
    const pageDown = this.options.keybindingLabel?.("tui.select.pageDown", "PgDn") || "PgDn";
    const position = this.options.theme.fg(
      "dim",
      ` ${start + 1}–${end} of ${lines.length} · C-u/d half-page · ${pageUp}/${pageDown} page `,
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
    const visible = this.visibleRuns(runs, Math.max(1, height - 1));
    const left = [
      this.options.theme.fg("accent", this.listHeading(runs, visible)),
      ...visible.map(({ run, index }) => this.runLine(run, index, leftWidth, runs)),
    ];
    const detail = this.detailWindow(this.detailLines(selected, rightWidth), height, rightWidth);
    return Array.from(
      { length: height },
      (_, index) =>
        `${this.outerBorder("│")}${pad(left[index] ?? "", leftWidth)}${this.innerBorder(
          "│",
        )}${pad(detail[index] ?? "", rightWidth)}${this.outerBorder("│")}`,
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
    const visible = this.visibleRuns(runs, listHeight - 1);
    const list = [
      this.options.theme.fg("accent", this.listHeading(runs, visible)),
      ...visible.map(({ run, index }) => this.runLine(run, index, inner, runs)),
    ];
    const divider = `${this.outerBorder("├")}${this.innerBorder("─".repeat(inner))}${this.outerBorder("┤")}`;
    const remaining = Math.max(0, height - list.length - 1);
    const detail = this.detailWindow(this.detailLines(selected, inner), remaining, inner);
    const frame = (line: string) =>
      `${this.outerBorder("│")}${pad(line, inner)}${this.outerBorder("│")}`;
    const lines = [...list.map(frame), divider, ...detail.map(frame)];
    while (lines.length < height) lines.push(frame(""));
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
          ? (() => {
              const visible = this.visibleRuns(runs, Math.max(1, height - 1));
              if (height <= 1)
                return visible.map(({ run, index }) => this.runLine(run, index, inner, runs));
              return [
                this.options.theme.fg("accent", this.listHeading(runs, visible)),
                ...visible.map(({ run, index }) => this.runLine(run, index, inner, runs)),
              ];
            })()
          : [this.options.theme.fg("dim", "No subagents. Start one with subagent_start.")];
    if (!this.details) {
      this.detailMaxScroll = 0;
      this.detailLineCount = 0;
    }
    const frame = (line: string) =>
      `${this.outerBorder("│")}${pad(line, inner)}${this.outerBorder("│")}`;
    const rendered = lines.slice(0, height).map(frame);
    while (rendered.length < height) rendered.push(frame(""));
    return rendered;
  }

  invalidate(): void {
    this.prompt?.input.invalidate();
  }
}
