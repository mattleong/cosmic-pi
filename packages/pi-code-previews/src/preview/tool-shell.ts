import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { CompactAnimationScheduler } from "../tools/compact-summary";
import { createCompactToolShell, type CompactShellOptions } from "./compact-shell";
import { recordPreviewResult, renderWithPreviewIssues } from "./preview-issues";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  BorderedToolCall,
  borderState,
  renderWithBorderSlot,
  shouldRenderBorderResultSeparately,
  syncBorderShellChrome,
} from "./bordered-tool-call";
import {
  renderTimedResultFooter,
  TimingPreservedComponent,
  timingState,
  updateToolCallTiming,
  unwrapTimingComponent,
  withLastComponent,
} from "./tool-timing";
import { type ToolCallBackgroundMode } from "../config/schema";
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
    result?: AgentToolResult<unknown>,
    expandedContent?: (context: ToolRenderContext<TState, TArgs>) => Component,
  ): Component;
}

export function createCodePreviewToolShell(
  mode: ToolCallBackgroundMode = codePreviewSettings.toolCallBackground,
  compact?: CompactShellOptions,
  scheduleAnimation: CompactAnimationScheduler | undefined = compact?.scheduleAnimation,
): CodePreviewToolShell {
  if (compact && codePreviewSettings.toolCallCollapsedStyle === "compact")
    return createCompactToolShell(mode, { ...compact, scheduleAnimation });
  const summary = compact?.compactSummary;
  const animateProgress = compact?.animateProgress ?? false;
  return {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, render) =>
      renderCodePreviewCall(
        mode,
        context,
        theme,
        summary ? (current) => renderWithPreviewIssues(render, summary, current, theme) : render,
        scheduleAnimation,
        animateProgress,
      ),
    renderResult: (context, theme, render, result) => {
      recordPreviewResult(context, result);
      return renderCodePreviewResult(
        mode,
        context,
        theme,
        render,
        scheduleAnimation,
        animateProgress,
      );
    },
  };
}

function renderCodePreviewCall<TState, TArgs>(
  mode: ToolCallBackgroundMode,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
  scheduleAnimation: CompactAnimationScheduler | undefined,
  animateProgress: boolean,
): Component {
  if (mode !== "border") {
    const state = timingState(context);
    const component = render(
      withLastComponent(context, unwrapTimingComponent(context.lastComponent)),
    );
    const previousWrapped = state.codePreviewTimingCallComponent;
    const wrapped =
      previousWrapped instanceof TimingPreservedComponent && previousWrapped.component === component
        ? previousWrapped
        : new TimingPreservedComponent(component);
    state.codePreviewTimingCallComponent = wrapped;
    updateToolCallTiming(context, {
      animate: animateProgress,
      animateWithoutTiming: animateProgress,
      formatLabel: false,
      scheduleAnimation,
    });
    return wrapped;
  }
  const state = borderState(context);
  const previousShell = state.codePreviewBorderShell;
  const reuseShell =
    previousShell instanceof BorderedToolCall && state.codePreviewBorderTheme === theme;
  const callComponent = renderWithBorderSlot(state, "call", () =>
    render(withLastComponent(context, state.codePreviewBorderCallComponent)),
  );
  const timing = updateToolCallTiming(context, {
    scheduleAnimation,
    animateWithoutTiming: animateProgress,
  });
  state.codePreviewBorderCallComponent = callComponent;
  state.codePreviewBorderLastCallExecutionStarted = context.executionStarted;
  state.codePreviewBorderLastCallPartial = context.isPartial;
  const shell = reuseShell ? previousShell : new BorderedToolCall(theme);
  syncBorderShellChrome(shell, state, context, timing?.label);
  shell.setCall(callComponent);
  shell.setResult(state.codePreviewBorderResultComponent);
  state.codePreviewBorderShell = shell;
  state.codePreviewBorderTheme = theme;
  return shell;
}

function renderCodePreviewResult<TState, TArgs>(
  mode: ToolCallBackgroundMode,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
  scheduleAnimation: CompactAnimationScheduler | undefined,
  animateProgress: boolean,
): Component {
  const timing = updateToolCallTiming(context, {
    scheduleAnimation,
    animateWithoutTiming: animateProgress,
  });
  if (mode !== "border") {
    return renderTimedResultFooter(context, theme, render, timing?.label);
  }
  const state = borderState(context);
  const resultComponent = renderWithBorderSlot(state, "result", () =>
    render(withLastComponent(context, state.codePreviewBorderResultComponent)),
  );
  state.codePreviewBorderResultComponent = resultComponent;
  if (
    state.codePreviewBorderShell instanceof BorderedToolCall &&
    state.codePreviewBorderTheme === theme
  ) {
    syncBorderShellChrome(state.codePreviewBorderShell, state, context, timing?.label);
    state.codePreviewBorderShell.setResult(resultComponent);
  } else {
    const shell = new BorderedToolCall(theme);
    syncBorderShellChrome(shell, state, context, timing?.label);
    shell.setCall(state.codePreviewBorderCallComponent);
    shell.setResult(resultComponent);
    state.codePreviewBorderShell = shell;
    state.codePreviewBorderTheme = theme;
  }
  return shouldRenderBorderResultSeparately(state, context.isPartial)
    ? resultComponent
    : new Container();
}
