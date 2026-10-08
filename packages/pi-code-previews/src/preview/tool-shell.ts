import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { createCompactToolShell, type CompactShellOptions } from "./compact-shell";
import { withSelfBackground } from "./self-background";
import { recordPreviewResult, renderWithPreviewIssues } from "./preview-issues";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  borderState,
  frameBorderShell,
  renderWithBorderSlot,
  shouldRenderBorderResultSeparately,
} from "./bordered-tool-call";
import { renderTimedResultFooter, updateToolCallTiming, withLastComponent } from "./tool-timing";
import type { ToolCallBackgroundMode, ToolCallCollapsedStyle } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import type { ToolRenderContext } from "../tools/renderers/shared/types";

export interface CodePreviewToolShell {
  renderShell: "default" | "self";
  renderCall<TState, TArgs>(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: (context: ToolRenderContext<TState, TArgs>) => Component,
    expandedContent?: (context: ToolRenderContext<TState, TArgs>) => Component,
  ): Component;
  renderResult<TState, TArgs>(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: (context: ToolRenderContext<TState, TArgs>) => Component,
    result: AgentToolResult<unknown>,
    expandedContent?: (context: ToolRenderContext<TState, TArgs>) => Component,
  ): Component;
}

export function createCodePreviewToolShell(
  mode: ToolCallBackgroundMode = codePreviewSettings.toolCallBackground,
  compact: CompactShellOptions,
  selfShell = false,
  collapsedStyle: ToolCallCollapsedStyle = codePreviewSettings.toolCallCollapsedStyle,
): CodePreviewToolShell {
  if (collapsedStyle === "compact") return createCompactToolShell(mode, compact);
  const summary = compact.compactSummary;
  const animateProgress = compact.animateProgress ?? false;
  const timing = {
    scheduleAnimation: compact.scheduleAnimation,
    animateWithoutTiming: animateProgress,
    showShortTiming: compact.showShortTiming ?? false,
  };
  const shell: CodePreviewToolShell = {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, body) => {
      const render = (current: typeof context) =>
        renderWithPreviewIssues(body, summary, current, theme);
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
      recordPreviewResult(context, result);
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
