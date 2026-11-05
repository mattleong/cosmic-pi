import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { createCompactToolShell, type CompactShellOptions } from "./compact-shell";
import { withSelfBackground } from "./self-background";
import {
  PreviewFrames,
  previewIssues,
  renderWithPreviewIssues,
  type PreviewClosing,
} from "./preview-issues";
import { drawsRows, previewExpandLabel, showsAffordance } from "./expand-affordance";
import { clipToWidth } from "pi-cosmic-ui/manager";
import { renderExpansionAffordance } from "pi-cosmic-ui/tool";
import type { CompactSummaryProvider } from "../tools/compact-summary";
import {
  previewExpandedCall,
  previewExpandedResult,
  unwrapPreviewExpanded,
} from "./preview-expanded";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  borderState,
  type BorderedToolCall,
  frameBorderShell,
  renderWithBorderSlot,
  shouldRenderBorderResultSeparately,
} from "./bordered-tool-call";
import {
  renderTimedResultFooter,
  updateToolCallTiming,
  withLastComponent,
  type ToolTimingCadence,
} from "./tool-timing";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { codePreviewSettings } from "../config/state";

export type ShellRenderBody<TArgs, TState> = (
  context: ToolRenderContext<TState, TArgs>,
) => Component;

export interface CodePreviewToolShell<TArgs, TDetails, TState extends object> {
  renderShell: "default" | "self";
  renderCall(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: ShellRenderBody<TArgs, TState>,
    expandedContent?: ShellRenderBody<TArgs, TState>,
  ): Component;
  renderResult(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: ShellRenderBody<TArgs, TState>,
    result: AgentToolResult<TDetails>,
    expandedContent?: ShellRenderBody<TArgs, TState>,
  ): Component;
}

export function createCodePreviewToolShell<TArgs, TDetails, TState extends object>(
  mode: ToolCallBackgroundMode = codePreviewSettings.toolCallBackground,
  compact: CompactShellOptions<TArgs, TDetails, TState>,
  selfShell = false,
  collapsedStyle: ToolCallCollapsedStyle = codePreviewSettings.toolCallCollapsedStyle,
): CodePreviewToolShell<TArgs, TDetails, TState> {
  if (collapsedStyle === "compact") return createCompactToolShell(mode, compact);
  const summary = compact.compactSummary;
  const frames = new PreviewFrames<TArgs, TDetails, TState>();
  const animateProgress = compact.animateProgress ?? false;
  // Preview bodies draw time-based frames only when they declare animateProgress; otherwise only
  // the elapsed label changes while running.
  const cadence: ToolTimingCadence = animateProgress ? "frame" : "elapsed";
  const timing = {
    scheduleAnimation: compact.scheduleAnimation,
    animateWithoutTiming: animateProgress,
    cadence,
    showShortTiming: compact.showShortTiming ?? false,
  };
  const affordance = previewAffordance(frames, summary);
  const shell: CodePreviewToolShell<TArgs, TDetails, TState> = {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, body, content) => {
      const closing = mode === "border" ? undefined : affordance.call(context, theme);
      const render = (latest: typeof context) => {
        const current = withLastComponent(latest, unwrapPreviewExpanded(latest.lastComponent));
        const original = renderWithPreviewIssues(frames, body, summary, current, theme, closing);
        if (!current.expanded || !content) return original;
        const input = { frames, provider: summary, context: current, theme, original, content };
        const title = compact.previewTitle ?? compact.name;
        return previewExpandedCall({ ...input, title, heading: body });
      };
      if (mode !== "border") {
        const component = render(context);
        updateToolCallTiming(context, { ...timing, animate: animateProgress, formatLabel: false });
        return component;
      }
      const state = borderState(context);
      const callComponent = renderWithBorderSlot(state, "call", () =>
        render(withLastComponent(context, state.codePreviewBorderCallComponent)),
      );
      const label = updateToolCallTiming(context, timing)?.label;
      state.codePreviewBorderCallComponent = callComponent;
      state.codePreviewBorderLastCallExecutionStarted = context.executionStarted;
      state.codePreviewBorderLastCallPartial = context.isPartial;
      return affordance.border(frameBorderShell(context, theme, label), context);
    },
    renderResult: (context, theme, body, result, content) => {
      frames.record(context, result);
      const label = updateToolCallTiming(context, timing)?.label;
      const expandedTiming = mode === "border" ? undefined : label;
      const render = (latest: typeof context) => {
        const current = withLastComponent(latest, unwrapPreviewExpanded(latest.lastComponent));
        const original = body(current);
        if (!current.expanded || !content) return original;
        const input = { frames, provider: summary, context: current, theme, original, content };
        return previewExpandedResult({ ...input, timing: expandedTiming, collapsed: body });
      };
      // Expanded composition draws its own timing line at the body column.
      const footer = context.expanded && content ? undefined : label;
      if (mode !== "border")
        return renderTimedResultFooter(
          context,
          theme,
          render,
          footer,
          affordance.result(context, theme),
        );
      const state = borderState(context);
      const resultComponent = renderWithBorderSlot(state, "result", () =>
        render(withLastComponent(context, state.codePreviewBorderResultComponent)),
      );
      state.codePreviewBorderResultComponent = resultComponent;
      affordance.border(frameBorderShell(context, theme, label), context);
      return shouldRenderBorderResultSeparately(state, context.isPartial)
        ? resultComponent
        : new Container();
    },
  };
  return selfShell && shell.renderShell === "default" ? withSelfBackground(shell) : shell;
}

const affordanceRow = (theme: Theme, label: string | undefined, width: number) =>
  label === undefined ? [] : [clipToWidth(renderExpansionAffordance(label, false, theme), width)];

/** The collapsed call rows each row drew last, which its result slot reads to close the row. */
const collapsedCallRows = new WeakMap<WeakKey, readonly string[]>();

/**
 * The shell's `▸ label · C-o Expand` for a collapsed preview row, from the summary's `expandLabel`
 * or what expansion would reveal, unless a row already drew an affordance. It closes the row: the
 * result slot draws it after the timing, and the call slot draws it while there's no result.
 * Bordered rows label their bottom corner instead.
 */
function previewAffordance<TArgs, TDetails, TState extends object>(
  frames: PreviewFrames<TArgs, TDetails, TState>,
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
) {
  const label = (
    context: ToolRenderContext<TState, TArgs>,
    above: readonly string[],
    result: readonly string[] | undefined,
  ): string | undefined => {
    if (context.expanded || showsAffordance(above)) return undefined;
    const { summary } = previewIssues(frames, provider, context);
    if (!summary) return undefined;
    const shown = result !== undefined && drawsRows(result);
    return previewExpandLabel(summary, frames.currentResult(context), shown);
  };
  // Closures hold the row's state, never a render context, so replaced arguments can be released.
  const closing = (
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    draw: (
      current: ToolRenderContext<TState, TArgs>,
      rows: readonly string[],
    ) => string | undefined,
  ): PreviewClosing | undefined => {
    if (context.expanded) return undefined;
    const { state } = context;
    return (rows, width) => {
      const current = frames.latestFor(state);
      return current ? affordanceRow(theme, draw(current, rows), width) : [];
    };
  };
  return {
    call: (context: ToolRenderContext<TState, TArgs>, theme: Theme) =>
      closing(context, theme, (current, rows) => {
        collapsedCallRows.set(current.state, rows);
        // With a result, the result slot closes the row.
        return frames.currentResult(current) ? undefined : label(current, rows, undefined);
      }),
    result: (context: ToolRenderContext<TState, TArgs>, theme: Theme) =>
      closing(context, theme, (current, rows) =>
        label(current, [...(collapsedCallRows.get(current.state) ?? []), ...rows], rows),
      ),
    border: (shell: BorderedToolCall, context: ToolRenderContext<TState, TArgs>) => {
      const { state } = context;
      shell.setExpandFallback((call, result) => {
        const current = frames.latestFor(state);
        if (!current) return false;
        const shown = frames.currentResult(current) ? result : undefined;
        return label(current, [...call, ...result], shown) !== undefined;
      });
      return shell;
    },
  };
}
