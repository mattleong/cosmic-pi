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
import { BARE_TAG_RESERVE, tagFirstRow } from "./heading-tag";
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
  recordedExpandLabel,
  renderWithBorderSlot,
  shouldRenderBorderResultSeparately,
} from "./bordered-tool-call";
import {
  renderTimedResultFooter,
  updateToolCallTiming,
  withLastComponent,
  type ToolTimingCadence,
  type ToolTimingDecoration,
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
  const tag = previewHeadingTag(frames, summary);
  const shell: CodePreviewToolShell<TArgs, TDetails, TState> = {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, body, content) => {
      const closing = mode === "border" ? undefined : tag.call(context, theme);
      const render = (latest: typeof context) => {
        const current = withLastComponent(latest, unwrapPreviewExpanded(latest.lastComponent));
        const original = renderWithPreviewIssues(frames, body, summary, current, theme, closing);
        if (!current.expanded || !content) return original;
        const input = { frames, provider: summary, context: current, theme, original, content };
        const title = compact.previewTitle ?? compact.name;
        return previewExpandedCall({ ...input, title, heading: body });
      };
      if (mode !== "border") {
        // A collapsed body's hidden-content hint names the heading's tag rather than drawing a row.
        const component = context.expanded
          ? render(context)
          : renderWithBorderSlot(borderState(context), "call", () => render(context));
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
      return tag.border(frameBorderShell(context, theme, label), context);
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
        return renderWithBorderSlot(borderState(context), "result", () =>
          renderTimedResultFooter(
            context,
            theme,
            (latest) => tag.recordResult(latest, render(latest)),
            footer,
            tag.result(context, theme),
          ),
        );
      const state = borderState(context);
      const resultComponent = renderWithBorderSlot(state, "result", () =>
        render(withLastComponent(context, state.codePreviewBorderResultComponent)),
      );
      state.codePreviewBorderResultComponent = resultComponent;
      tag.border(frameBorderShell(context, theme, label), context);
      return shouldRenderBorderResultSeparately(state, context.isPartial)
        ? resultComponent
        : new Container();
    },
  };
  return selfShell && shell.renderShell === "default" ? withSelfBackground(shell) : shell;
}

/** The collapsed call rows each row drew last, which its result slot reads to place the tag. */
const collapsedCallRows = new WeakMap<WeakKey, readonly string[]>();

/** The collapsed result body each row built last, which its call slot draws to decide the tag. */
const collapsedResultBodies = new WeakMap<WeakKey, Component>();

/**
 * The shell's expansion tag for a collapsed preview row, `▸ label` or a bare `▸` on the heading's
 * first row: the label a body's hidden-content hint recorded, else the summary's `expandLabel` or
 * what expansion would reveal, unless a row already drew an affordance. The call slot decides it
 * from the rows both slots draw, so a row with a result still shows it on its heading; only a call
 * that draws nothing leaves the tag to its result's first row. Bordered rows label their bottom
 * corner instead.
 */
function previewHeadingTag<TArgs, TDetails, TState extends object>(
  frames: PreviewFrames<TArgs, TDetails, TState>,
  provider: CompactSummaryProvider<TArgs, TDetails, TState>,
) {
  const label = (
    context: ToolRenderContext<TState, TArgs>,
    above: readonly string[],
    result: readonly string[] | undefined,
  ): string | undefined => {
    if (context.expanded) return undefined;
    const hinted = recordedExpandLabel(borderState(context));
    if (hinted !== undefined) return hinted;
    if (showsAffordance(above)) return undefined;
    const { summary } = previewIssues(frames, provider, context);
    if (!summary) return undefined;
    const shown = result !== undefined && drawsRows(result);
    return previewExpandLabel(summary, frames.currentResult(context), shown);
  };
  // Closures hold the row's state, never a render context, so replaced arguments can be released.
  return {
    call: (context: ToolRenderContext<TState, TArgs>, theme: Theme): PreviewClosing | undefined => {
      if (context.expanded) return undefined;
      const { state } = context;
      return (width) => {
        const current = frames.latestFor(state);
        const result =
          current && frames.currentResult(current)
            ? (collapsedResultBodies.get(state)?.render(width) ?? [])
            : undefined;
        // The heading keeps room for the tag the result alone calls for; its own rows can only
        // withdraw it.
        const expected = current ? label(current, result ?? [], result) : undefined;
        return {
          reserve: expected === undefined ? 0 : BARE_TAG_RESERVE,
          place: (rows) => {
            collapsedCallRows.set(state, rows);
            if (!current || !drawsRows(rows)) return rows;
            const tag = label(current, [...rows, ...(result ?? [])], result);
            return tagFirstRow(rows, tag, theme, width);
          },
        };
      };
    },
    result: (
      context: ToolRenderContext<TState, TArgs>,
      theme: Theme,
    ): ToolTimingDecoration | undefined => {
      if (context.expanded) return undefined;
      const { state } = context;
      return (rows, body, width) => {
        const above = collapsedCallRows.get(state) ?? [];
        const current = frames.latestFor(state);
        if (!current || drawsRows(above)) return rows;
        return tagFirstRow(rows, label(current, [...above, ...body], body), theme, width);
      };
    },
    /** Remembers the collapsed result body the call slot draws to decide the tag. */
    recordResult: (context: ToolRenderContext<TState, TArgs>, body: Component): Component => {
      if (!context.expanded) collapsedResultBodies.set(context.state, body);
      return body;
    },
    border: (shell: BorderedToolCall, context: ToolRenderContext<TState, TArgs>) => {
      const { state } = context;
      shell.setExpandFallback((call, result) => {
        const current = frames.latestFor(state);
        if (!current) return undefined;
        const shown = frames.currentResult(current) ? result : undefined;
        return label(current, [...call, ...result], shown);
      });
      return shell;
    },
  };
}
