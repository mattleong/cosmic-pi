import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderContext } from "../tools/renderers/shared/types";
import { createCompactToolShell, type CompactShellOptions } from "./compact-shell";
import { withSelfBackground } from "./self-background";
import { PreviewFrames, renderWithPreviewIssues } from "./preview-issues";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  borderState,
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
  const shell: CodePreviewToolShell<TArgs, TDetails, TState> = {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, body) => {
      const render = (current: typeof context) =>
        renderWithPreviewIssues(frames, body, summary, current, theme);
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
      return frameBorderShell(context, theme, label);
    },
    renderResult: (context, theme, render, result) => {
      frames.record(context, result);
      const label = updateToolCallTiming(context, timing)?.label;
      if (mode !== "border") return renderTimedResultFooter(context, theme, render, label);
      const state = borderState(context);
      const resultComponent = renderWithBorderSlot(state, "result", () =>
        render(withLastComponent(context, state.codePreviewBorderResultComponent)),
      );
      state.codePreviewBorderResultComponent = resultComponent;
      frameBorderShell(context, theme, label);
      return shouldRenderBorderResultSeparately(state, context.isPartial)
        ? resultComponent
        : new Container();
    },
  };
  return selfShell && shell.renderShell === "default" ? withSelfBackground(shell) : shell;
}
