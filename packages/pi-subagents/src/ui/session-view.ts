import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  visibleWidth,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { formatElapsed } from "pi-cosmic-core/display";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeDiagnosticContent, sanitizeTerminalLine } from "pi-cosmic-core/security";
import { renderSessionFooter } from "pi-cosmic-ui/footer/session";
import { clipToWidth, spinnerFrameAt } from "pi-cosmic-ui/manager";
import { formatKeyIds, joinKeyHints, keyHint, keyHintRows } from "pi-cosmic-ui/manager/key-labels";
import { padListDetailRow } from "pi-cosmic-ui/manager/list-detail";
import { isResumableRunState, type SubagentRunView } from "../run/model.ts";
import { userRunText } from "../run/warnings.ts";
import { formatRunRouteLine } from "./run-presentation.ts";
import { canInterruptRun, runStateColor, runStateGlyph } from "./run-state.ts";
import type { SessionTranscript } from "./session-transcript.ts";

/** What Enter does with the editor's text, by the run's state. */
export type SessionSubmitKind = "reply" | "send" | "resume";

export const sessionSubmitKind = (run: SubagentRunView): SessionSubmitKind =>
  run.state === "waiting_for_parent" ? "reply" : isResumableRunState(run.state) ? "resume" : "send";

const SUBMIT_VERBS = {
  reply: "Reply",
  send: "Send",
  resume: "Resume",
} as const satisfies Record<SessionSubmitKind, string>;

/**
 * What the editor's border says while the run is busy, as Pi's own working row does: nothing once
 * the run is idle, when its glyph in the header says how it ended.
 */
export const sessionWorkingStatus = (
  run: SubagentRunView,
  now: number,
): { readonly glyph: string; readonly text: string } | undefined => {
  switch (run.state) {
    case "starting":
    case "running":
    case "stopping":
      return {
        glyph: runStateGlyph(run.state, spinnerFrameAt(now)),
        text: `Working · ${formatElapsed(Math.max(0, now - run.startedAt))}`,
      };
    case "waiting_for_parent":
      return { glyph: runStateGlyph(run.state), text: "Waiting for reply" };
    case "paused":
    case "completed":
    case "failed":
    case "stopped":
      return undefined;
  }
  return Fn.absurd(run.state);
};

/** Pi's editor with the run's working status in its top border, where Pi shows its own. */
class SessionEditor extends Editor {
  /** The styled status, or `undefined` for a plain border. */
  workingStatus: string | undefined;

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const status = this.workingStatus;
    const statusWidth = status === undefined ? 0 : visibleWidth(status);
    // Pi's own border keeps its scroll marker; the status gives way to it and to a narrow row.
    if (status === undefined || hiddenLineCount > 0 || width < statusWidth + 5)
      return super.renderTopBorder(width, hiddenLineCount);
    const rule = Fn.pipe("─", Str.repeat(width - statusWidth - 4));
    return `${this.borderColor("── ")}${status}${this.borderColor(` ${rule}`)}`;
  }
}

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (text) => theme.fg("borderMuted", text),
  selectList: {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  },
});

const MAX_QUEUED_ROWS = 3;

type ViewportMotion = "pageUp" | "pageDown" | "halfUp" | "halfDown" | "lineUp" | "lineDown";

const VIEWPORT_KEYS = [
  ["tui.altScreen.pageUp", "pageUp"],
  ["tui.altScreen.pageDown", "pageDown"],
  ["tui.altScreen.halfPageUp", "halfUp"],
  ["tui.altScreen.halfPageDown", "halfDown"],
  ["tui.altScreen.lineUp", "lineUp"],
  ["tui.altScreen.lineDown", "lineDown"],
] as const satisfies ReadonlyArray<
  readonly [Parameters<KeybindingsManager["matches"]>[1], ViewportMotion]
>;

export interface SessionViewOptions {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly getHeight: () => number;
  readonly getNow: () => number;
  readonly transcript: SessionTranscript;
  /** The run as the projection shows it now; `undefined` once it is gone. */
  readonly getRun: () => SubagentRunView | undefined;
  readonly onSubmit: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onLeave: () => void;
}

/**
 * A subagent's session as a screen, laid out like Pi's own: a header naming the run, its
 * transcript, queued messages, an editor whose border carries the working status, and a footer. It owns only input, scroll, and layout state; the
 * conversation and every action belong to the run's owner.
 */
export class SubagentSessionView implements Component, Focusable {
  private readonly options: SessionViewOptions;
  private readonly editor: SessionEditor;
  private hasFocus = false;
  /** The first visible transcript line while scrolled back; `undefined` follows the newest. */
  private top: number | undefined;
  private bodyHeight = 1;
  private lineCount = 0;
  private notice: string | undefined;
  private loaded = false;
  /** Messages sent into a running turn that the conversation hasn't shown yet. */
  private queued: string[] = [];
  private queuedSince = 0;

  constructor(options: SessionViewOptions) {
    this.options = options;
    this.editor = new SessionEditor(options.tui, editorTheme(options.theme), { paddingX: 1 });
    this.editor.onSubmit = (text) => {
      if (!text) return;
      this.editor.addToHistory(text);
      this.notice = undefined;
      this.top = undefined;
      const run = options.getRun();
      // Only a message steering a working turn waits in the run's queue: a reply answers its
      // question at once, and a resume starts the next turn with it.
      if (run && sessionSubmitKind(run) === "send") this.queued.push(text);
      options.onSubmit(text);
    };
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value;
  }

  /** A new snapshot arrived: the view stops loading, and what it holds needs no queue beside it. */
  markLoaded(): void {
    this.loaded = true;
    this.queued = [];
    this.queuedSince = this.options.transcript.userMessageCount;
  }

  /** A short problem to show above the editor until the next message is sent. */
  setNotice(notice: string | undefined): void {
    this.notice = notice;
    this.options.tui.requestRender();
  }

  /** Puts text back in the editor, as when a message couldn't be delivered. */
  restoreDraft(text: string): void {
    const index = this.queued.lastIndexOf(text);
    if (index >= 0) this.queued.splice(index, 1);
    if (!this.editor.getText()) this.editor.setText(text);
  }

  /** The queued messages the conversation still hasn't shown, oldest first. */
  private queuedMessages(): ReadonlyArray<string> {
    const shown = this.options.transcript.userMessageCount;
    if (shown > this.queuedSince) this.queued.splice(0, shown - this.queuedSince);
    this.queuedSince = shown;
    return this.queued;
  }

  invalidate(): void {
    this.options.transcript.invalidate();
    this.editor.invalidate();
  }

  handleInput(data: string): void {
    const { keybindings, transcript } = this.options;
    const matches = (id: Parameters<KeybindingsManager["matches"]>[1]) =>
      invokeHostCallback(() => keybindings.matches(data, id), false);
    const run = this.options.getRun();
    if (matches("app.interrupt")) {
      if (run && canInterruptRun(run)) this.options.onInterrupt();
      else this.options.onLeave();
      return;
    }
    if (matches("app.exit") && !this.editor.getText()) return this.options.onLeave();
    if (matches("app.tools.expand")) {
      transcript.setExpanded(!transcript.toolsExpanded);
      return this.options.tui.requestRender();
    }
    if (matches("app.thinking.toggle")) {
      transcript.toggleThinking();
      return this.options.tui.requestRender();
    }
    if (matches("tui.altScreen.top")) return this.scrollTo(0);
    if (matches("tui.altScreen.bottom")) return this.scrollTo(undefined);
    for (const [id, motion] of VIEWPORT_KEYS) if (matches(id)) return this.scroll(motion);
    this.editor.handleInput(data);
    this.options.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(event.wheelDelta);
    return { handled: true, render: true };
  }

  private scroll(motion: ViewportMotion): void {
    const page = Math.max(1, this.bodyHeight - 1);
    const half = Math.max(1, Math.floor(this.bodyHeight / 2));
    const lines = {
      pageUp: -page,
      pageDown: page,
      halfUp: -half,
      halfDown: half,
      lineUp: -1,
      lineDown: 1,
    } as const satisfies Record<ViewportMotion, number>;
    this.scrollBy(lines[motion]);
  }

  private scrollBy(lines: number): void {
    const bottom = Math.max(0, this.lineCount - this.bodyHeight);
    this.scrollTo(Math.max(0, (this.top ?? bottom) + lines));
  }

  private scrollTo(top: number | undefined): void {
    this.top = top;
    this.options.tui.requestRender();
  }

  render(width: number): string[] {
    const { theme, transcript } = this.options;
    const height = Math.max(1, this.options.getHeight());
    const run = this.options.getRun();
    const now = this.options.getNow();
    const pad = (line: string) => padListDetailRow(line, width);
    const header = Arr.map(this.headerRows(run, width, now), pad);
    const working = run && this.loaded ? sessionWorkingStatus(run, now) : undefined;
    this.editor.workingStatus =
      working &&
      `${theme.fg(run ? runStateColor(run.state) : "accent", working.glyph)} ${theme.fg("muted", working.text)}`;
    const editor = this.editor.render(width);
    const footer = Arr.map(run ? this.footerRows(run, width) : [], pad);
    const queued = Arr.map(this.queuedRows(width), pad);
    const notices = Arr.map(this.noticeRows(run, width), pad);
    const chrome = header.length + queued.length + notices.length + editor.length + footer.length;
    const lines = transcript.render(width);
    this.lineCount = lines.length;
    const room = Math.max(1, height - chrome);
    // A view scrolled back gives one row to the marker that says how much lies below.
    const scrolledBack = this.top !== undefined && this.top < Math.max(0, lines.length - room);
    this.bodyHeight = scrolledBack ? Math.max(1, room - 1) : room;
    const bottom = Math.max(0, lines.length - this.bodyHeight);
    // Scrolling back to the newest line resumes following it.
    if (this.top !== undefined && this.top >= bottom) this.top = undefined;
    const top = this.top ?? bottom;
    const body = Arr.map(lines.slice(top, top + this.bodyHeight), pad);
    const below = lines.length - top - body.length;
    const marker =
      below > 0 ? [pad(clipToWidth(` ${theme.fg("muted", `↓ ${below} more below`)}`, width))] : [];
    // `Arr.makeBy` never returns an empty array, so a full body asks for no fill at all.
    const missing = height - chrome - marker.length - body.length;
    const fill = missing > 0 ? Arr.makeBy(missing, () => pad("")) : [];
    return [
      ...header,
      ...body,
      ...fill,
      ...marker,
      ...queued,
      ...notices,
      ...editor,
      ...footer,
    ].slice(0, height);
  }

  /** The run's glyph, name, and route, with the keys that differ from Pi's own beside or below. */
  private headerRows(run: SubagentRunView | undefined, width: number, now: number): string[] {
    const { theme } = this.options;
    if (!run) return [clipToWidth(` ${theme.fg("muted", "Subagent session")}`, width)];
    const glyph = theme.fg(runStateColor(run.state), runStateGlyph(run.state, spinnerFrameAt(now)));
    const reason = run.state === "failed" ? Str.split(userRunText(run).error ?? "", "\n")[0] : "";
    const identity = ` ${glyph} ${theme.bold(sanitizeTerminalLine(run.name))}${theme.fg("dim", " · ")}${formatRunRouteLine(run, theme)}${
      reason
        ? theme.fg("dim", " · ") +
          theme.fg("error", sanitizeDiagnosticContent(reason, { maximumLength: 200 }))
        : ""
    }`;
    const hints = this.hintBar(run);
    const gap = width - visibleWidth(identity) - visibleWidth(hints) - 1;
    if (gap >= 2) return [`${identity}${Fn.pipe(" ", Str.repeat(gap))}${theme.fg("dim", hints)}`];
    return [
      clipToWidth(identity, width),
      ...keyHintRows(hints, width, (row) => theme.fg("dim", row)),
    ];
  }

  /** Messages still in the run's queue, as Pi lists its own above the editor. */
  private queuedRows(width: number): string[] {
    const { theme } = this.options;
    const queued = this.queuedMessages().slice(-MAX_QUEUED_ROWS);
    if (queued.length === 0) return [];
    return [
      "",
      ...Arr.map(queued, (text) =>
        clipToWidth(
          ` ${theme.fg("dim", `Steering: ${sanitizeTerminalLine(Str.split(text, "\n")[0] ?? "")}`)}`,
          width,
        ),
      ),
    ];
  }

  /** What Pi would show as a notice: a delivery problem, a missing run, or a pending load. */
  private noticeRows(run: SubagentRunView | undefined, width: number): string[] {
    const { theme } = this.options;
    const row = (tone: "warning" | "muted", text: string) =>
      clipToWidth(` ${theme.fg(tone, text)}`, width);
    return [
      ...(this.notice ? [row("warning", this.notice)] : []),
      ...(!run
        ? [row("muted", "This subagent is gone")]
        : !this.loaded
          ? [row("muted", "Loading conversation…")]
          : []),
    ];
  }

  private footerRows(run: SubagentRunView, width: number): string[] {
    const [first, ...rest] = Str.split(run.model, "/");
    const [provider, id] = rest.length > 0 ? [first, Arr.join(rest, "/")] : ["", run.model];
    return invokeHostCallback(
      () =>
        renderSessionFooter(
          {
            model: { provider: sanitizeTerminalLine(provider), id: sanitizeTerminalLine(id) },
            thinking: run.effort,
            thinkingMark: run.openaiFastMode ? "⚡" : undefined,
            cwd: run.cwd,
            totals: { ...run.usage, cost: run.usage.cost ?? 0 },
            contextPercent: run.usage.contextPercent,
          },
          width,
          this.options.theme,
        ),
      [],
    );
  }

  /** Only what differs from a native session: what Enter does here, and how to get back. */
  private hintBar(run: SubagentRunView): string {
    const { keybindings } = this.options;
    const key = (id: Parameters<KeybindingsManager["matches"]>[1], fallback: string) =>
      invokeHostCallback(() => formatKeyIds(keybindings.getKeys(id).slice(0, 1)), "") || fallback;
    const submit = sessionSubmitKind(run);
    return joinKeyHints([
      submit !== "send" && keyHint("Enter", SUBMIT_VERBS[submit]),
      canInterruptRun(run)
        ? keyHint(key("app.exit", "C-d"), "Back")
        : keyHint(key("app.interrupt", "Esc"), "Back"),
    ]);
  }
}
