import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Text,
  type TuiMouseEvent,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { hiddenPreviewExpandHint, hiddenPreviewExpandLabel } from "./format";
import type { RendererState } from "../tools/renderers/shared/types";
import { clipToWidth } from "pi-cosmic-ui/manager";

export type BorderSlot = "call" | "result";

export type BorderState = RendererState & {
  codePreviewBorderCallComponent?: Component;
  codePreviewBorderResultComponent?: Component;
  codePreviewBorderShell?: BorderedToolCall;
  codePreviewBorderTheme?: Theme;
  codePreviewBorderCurrentSlot?: BorderSlot | undefined;
  codePreviewBorderCallExpandLabel?: string | undefined;
  codePreviewBorderResultExpandLabel?: string | undefined;
  codePreviewBorderLastCallExecutionStarted?: boolean;
  codePreviewBorderLastCallPartial?: boolean;
};

type BorderColorKey = "borderMuted" | "warning" | "success" | "error";

type BorderRenderContext = {
  isError: boolean;
  isPartial: boolean;
};

export function borderState(context: { state: unknown }): BorderState {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  return context.state as BorderState;
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

function getBorderExpandLabel(state: BorderState): string | undefined {
  return state.codePreviewBorderResultExpandLabel ?? state.codePreviewBorderCallExpandLabel;
}

export function syncBorderShellChrome(
  shell: BorderedToolCall,
  state: BorderState,
  context: BorderRenderContext,
  timingLabel: string | undefined,
): void {
  shell.setBorderColor(borderColorKey(context));
  shell.setExpandLabel(getBorderExpandLabel(state));
  shell.setTimingLabel(timingLabel);
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

function borderColorKey(context: BorderRenderContext): BorderColorKey {
  if (context.isError) return "error";
  if (context.isPartial) return "warning";
  return "success";
}

const RESET_ANSI = "\x1b[0m";

export class BorderedToolCall implements Component {
  private readonly body = new Container();
  private callComponent: Component | undefined;
  private borderColorKey: BorderColorKey = "borderMuted";
  private expandLabel: string | undefined;
  private timingLabel: string | undefined;
  private resultComponent: Component | undefined;
  private cachedWidth: number | undefined;
  private cachedRows: string[] | undefined;
  private readonly theme: Theme;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setBorderColor(colorKey: BorderColorKey): void {
    if (this.borderColorKey === colorKey) return;
    this.borderColorKey = colorKey;
    this.invalidateCache();
  }

  setCall(component: Component | undefined): void {
    this.callComponent = component;
    this.invalidateCache();
  }

  setExpandLabel(label: string | undefined): void {
    if (this.expandLabel === label) return;
    this.expandLabel = label;
    this.invalidateCache();
  }

  setTimingLabel(label: string | undefined): void {
    if (this.timingLabel === label) return;
    this.timingLabel = label;
    this.invalidateCache();
  }

  setResult(component: Component | undefined): void {
    this.resultComponent = component;
    this.invalidateCache();
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedRows) return this.cachedRows;
    const rows = this.renderUncached(width);
    this.cachedWidth = width;
    this.cachedRows = rows;
    return rows;
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
    this.invalidateCache();
    this.callComponent?.invalidate?.();
    this.resultComponent?.invalidate?.();
  }

  private invalidateCache(): void {
    this.cachedWidth = undefined;
    this.cachedRows = undefined;
  }

  private renderUncached(width: number): string[] {
    // A frame needs two border cells, two padding cells, and at least one content cell.
    if (width < MIN_FRAMED_WIDTH) return this.renderBody(Math.max(1, width));
    const innerWidth = width - 4;
    const border = (value: string) => this.theme.fg(this.borderColorKey, value);
    const timing = this.timingLabel ? ` ${this.theme.fg("muted", this.timingLabel)} ` : "";
    const expand = this.expandLabel ? ` ${this.expandLabel} ` : "";
    return [
      renderBorder(width, border, "╭", "╮", timing),
      ...this.renderBody(innerWidth).map((line) => this.frameLine(line, innerWidth, border)),
      renderBorder(width, border, "╰", "╯", expand),
    ];
  }

  private renderBody(width: number): string[] {
    this.body.clear();
    if (this.callComponent) this.body.addChild(this.callComponent);
    if (this.resultComponent) this.body.addChild(this.resultComponent);
    return this.body.render(width);
  }

  private frameLine(line: string, innerWidth: number, border: (value: string) => string): string {
    const truncated = clipToWidth(line, innerWidth, "");
    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
    // FullWidthDiffText diff lines have an active diff background that extends
    // to the end (no trailing \x1b[49m). Let the diff bg cover padding and
    // the right margin space, then reset bg right before the border │.
    // For non-diff lines, RESET_ANSI goes before padding to clear attributes.
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

/** True when the line opens with a truecolor background sequence (`ESC [48;2;r;g;bm`). */
function startsWithDiffBackground(line: string): boolean {
  if (!line.startsWith("\x1b[48;2;")) return false;
  const end = line.indexOf("m", 7);
  if (end < 0) return false;
  const channels = line.slice(7, end).split(";");
  return channels.length === 3 && channels.every((channel) => /^\d+$/.test(channel));
}

export function hiddenPreviewExpandHintForShell(state: RendererState, theme: Theme): string {
  // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
  const shellState = state as BorderState;
  const slot = shellState.codePreviewBorderCurrentSlot;
  if (slot !== "call" && slot !== "result") return hiddenPreviewExpandHint(theme);
  if (slot === "call")
    shellState.codePreviewBorderCallExpandLabel = hiddenPreviewExpandLabel(theme);
  else shellState.codePreviewBorderResultExpandLabel = hiddenPreviewExpandLabel(theme);
  return "";
}

export function renderHiddenPreviewExpandHint(state: RendererState, theme: Theme): Component {
  const hint = hiddenPreviewExpandHintForShell(state, theme);
  return hint ? new Text(hint, 0, 0) : new Container();
}
