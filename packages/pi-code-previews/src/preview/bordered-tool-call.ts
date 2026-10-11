import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type TuiMouseEvent,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
import type { RendererState } from "../tools/renderers/shared/types";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance, toolExpandHint } from "pi-cosmic-ui/tool";

type BorderSlot = "call" | "result";

interface BorderState {
  codePreviewBorderCallComponent?: Component;
  codePreviewBorderResultComponent?: Component;
  codePreviewBorderShell?: BorderedToolCall;
  codePreviewBorderTheme?: Theme;
  codePreviewBorderCurrentSlot?: BorderSlot | undefined;
  codePreviewBorderCallExpandLabel?: string | undefined;
  codePreviewBorderResultExpandLabel?: string | undefined;
  codePreviewBorderLastCallExecutionStarted?: boolean;
  codePreviewBorderLastCallPartial?: boolean;
}

type BorderColorKey = "borderMuted" | "warning" | "success" | "error";

const borderStates = new WeakMap<object, BorderState>();

export function borderState(context: { readonly state: unknown }): BorderState {
  const owner = context.state;
  if (!Predicate.isObject(owner)) return {};
  const existing = borderStates.get(owner);
  if (existing) return existing;
  const created: BorderState = {};
  borderStates.set(owner, created);
  return created;
}

export function renderWithBorderSlot<T>(state: BorderState, slot: BorderSlot, render: () => T): T {
  const previousSlot = state.codePreviewBorderCurrentSlot;
  state.codePreviewBorderCurrentSlot = slot;
  if (slot === "call") state.codePreviewBorderCallExpandLabel = undefined;
  else state.codePreviewBorderResultExpandLabel = undefined;
  try {
    return render();
  } finally {
    state.codePreviewBorderCurrentSlot = previousSlot;
  }
}

export function shouldRenderBorderResultSeparately(
  state: BorderState,
  isPartial: boolean,
): boolean {
  return (
    state.codePreviewBorderLastCallPartial === undefined ||
    (state.codePreviewBorderLastCallPartial !== isPartial &&
      state.codePreviewBorderLastCallExecutionStarted === true)
  );
}

export function borderColorKey(context: { isError: boolean; isPartial: boolean }): BorderColorKey {
  if (context.isError) return "error";
  if (context.isPartial) return "warning";
  return "success";
}

export function frameBorderShell(
  context: { state: unknown; isError: boolean; isPartial: boolean },
  theme: Theme,
  timingLabel: string | undefined,
): BorderedToolCall {
  const state = borderState(context);
  const previous = state.codePreviewBorderShell;
  const shell =
    previous instanceof BorderedToolCall && state.codePreviewBorderTheme === theme
      ? previous
      : new BorderedToolCall(theme);
  shell.setContent(
    state.codePreviewBorderCallComponent,
    state.codePreviewBorderResultComponent,
    state,
    borderColorKey(context),
    timingLabel,
  );
  state.codePreviewBorderShell = shell;
  state.codePreviewBorderTheme = theme;
  return shell;
}

const RESET_ANSI = "\x1b[0m";

export class BorderedToolCall implements Component {
  private readonly body = new Container();
  private borderColorKey: BorderColorKey = "borderMuted";
  private expandLabel: string | undefined;
  private timingLabel: string | undefined;
  private cache: { width: number; rows: string[] } | undefined;
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setContent(
    call: Component | undefined,
    result: Component | undefined,
    state: BorderState,
    color: BorderColorKey,
    timingLabel: string | undefined,
  ): void {
    this.body.clear();
    if (call) this.body.addChild(call);
    if (result) this.body.addChild(result);
    this.borderColorKey = color;
    this.expandLabel =
      state.codePreviewBorderResultExpandLabel ?? state.codePreviewBorderCallExpandLabel;
    this.timingLabel = timingLabel;
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width !== width) this.cache = { width, rows: this.renderUncached(width) };
    return this.cache.rows;
  }

  handleMouse(event: TuiMouseEvent) {
    const framed = event.width >= MIN_FRAMED_WIDTH;
    const width = Math.max(1, event.width - (framed ? 4 : 0));
    const x = event.x - (framed ? 2 : 0);
    const y = event.y - (framed ? 1 : 0);
    const height = event.height - (framed ? 2 : 0);
    if (x < 0 || x >= width || y < 0 || y >= height) return undefined;
    return this.body.handleMouse({ ...event, x, y, width, height });
  }

  invalidate(): void {
    this.cache = undefined;
    this.body.invalidate();
  }

  private renderUncached(width: number): string[] {
    if (width < MIN_FRAMED_WIDTH) return this.body.render(Math.max(1, width));
    const innerWidth = width - 4;
    const border = (value: string) => this.theme.fg(this.borderColorKey, value);
    const timing = this.timingLabel ? ` ${this.theme.fg("muted", this.timingLabel)} ` : "";
    const expand = this.expandLabel ? ` ${this.expandLabel} ` : "";
    return [
      renderBorder(width, border, "╭", "╮", timing),
      ...this.body.render(innerWidth).map((line) => this.frameLine(line, innerWidth, border)),
      renderBorder(width, border, "╰", "╯", expand),
    ];
  }

  private frameLine(line: string, innerWidth: number, border: (value: string) => string): string {
    const truncated = clipToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    if (startsWithDiffBackground(truncated)) {
      return `${border("│")} ${truncated}${padding} \x1b[49m${border("│")}${RESET_ANSI}`;
    }
    return `${border("│")} ${truncated}${RESET_ANSI}${padding} ${border("│")}`;
  }
}

const MIN_FRAMED_WIDTH = 5;

function renderBorder(
  width: number,
  border: (value: string) => string,
  open: string,
  close: string,
  label: string,
): string {
  const innerWidth = width - 2;
  const labelWidth = visibleWidth(label);
  if (labelWidth === 0 || labelWidth > innerWidth)
    return border(`${open}${"─".repeat(innerWidth)}${close}`);
  return `${border(open)}${border("─".repeat(innerWidth - labelWidth))}${label}${border(close)}`;
}

function startsWithDiffBackground(line: string): boolean {
  if (!line.startsWith("\x1b[48;2;")) return false;
  const end = line.indexOf("m", 7);
  if (end < 0) return false;
  const channels = line.slice(7, end).split(";");
  return channels.length === 3 && channels.every((channel) => /^\d+$/.test(channel));
}

export function hiddenPreviewExpandHintForShell(
  state: RendererState,
  theme: Theme,
  label: string,
): string {
  const shellState = borderState({ state });
  const slot = shellState.codePreviewBorderCurrentSlot;
  if (slot !== "call" && slot !== "result") return renderExpansionAffordance(label, false, theme);
  const corner = theme.fg("muted", toolExpandHint());
  if (slot === "call") shellState.codePreviewBorderCallExpandLabel = corner;
  else shellState.codePreviewBorderResultExpandLabel = corner;
  return "";
}

export function renderHiddenPreviewExpandHint(
  state: RendererState,
  theme: Theme,
  label: string,
): Component {
  const hint = hiddenPreviewExpandHintForShell(state, theme, label);
  return hint ? new Text(hint, 0, 0) : new Container();
}
