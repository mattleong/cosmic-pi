import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, type Component } from "@earendil-works/pi-tui";
import {
  BorderedToolCall,
  borderState,
  renderWithBorderSlot,
  shouldRenderBorderResultSeparately,
  syncBorderShellChrome,
} from "./bordered-tool-call";
import {
  isToolCallTimingOnlyRender,
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
  ): Component;
  renderResult<TState, TArgs>(
    context: ToolRenderContext<TState, TArgs>,
    theme: Theme,
    render: (context: ToolRenderContext<TState, TArgs>) => Component,
  ): Component;
}

export function createCodePreviewToolShell(
  mode: ToolCallBackgroundMode = codePreviewSettings.toolCallBackground,
): CodePreviewToolShell {
  return {
    renderShell: mode === "on" ? "default" : "self",
    renderCall: (context, theme, render) => renderCodePreviewCall(mode, context, theme, render),
    renderResult: (context, theme, render) => renderCodePreviewResult(mode, context, theme, render),
  };
}

function renderCodePreviewCall<TState, TArgs>(
  mode: ToolCallBackgroundMode,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
): Component {
  if (mode !== "border") {
    const state = timingState(context);
    if (
      context.isPartial &&
      isToolCallTimingOnlyRender(state) &&
      state.codePreviewTimingCallComponent
    ) {
      updateToolCallTiming(context, { animate: false, formatLabel: false });
      return state.codePreviewTimingCallComponent;
    }
    const component = render(
      withLastComponent(context, unwrapTimingComponent(context.lastComponent)),
    );
    const previousWrapped = state.codePreviewTimingCallComponent;
    const wrapped =
      previousWrapped instanceof TimingPreservedComponent && previousWrapped.component === component
        ? previousWrapped
        : new TimingPreservedComponent(component, state);
    state.codePreviewTimingCallComponent = wrapped;
    updateToolCallTiming(context, { animate: false, formatLabel: false });
    return wrapped;
  }
  const state = borderState(context);
  const timingOnly = context.isPartial === true && isToolCallTimingOnlyRender(state);
  const previousShell = state.codePreviewBorderShell;
  const reuseShell =
    previousShell instanceof BorderedToolCall && state.codePreviewBorderTheme === theme;
  const reusedCall = timingOnly ? state.codePreviewBorderCallComponent : undefined;
  const callComponent =
    reusedCall ??
    renderWithBorderSlot(state, "call", () =>
      render(withLastComponent(context, state.codePreviewBorderCallComponent)),
    );
  const timing = updateToolCallTiming(context);
  state.codePreviewBorderCallComponent = callComponent;
  state.codePreviewBorderLastCallExecutionStarted = context.executionStarted;
  state.codePreviewBorderLastCallPartial = context.isPartial;
  const shell = reuseShell ? previousShell : new BorderedToolCall(theme, state);
  syncBorderShellChrome(shell, state, context, timing?.label);
  if (!reusedCall || !reuseShell) shell.setCall(callComponent);
  if (!timingOnly || !reuseShell) shell.setResult(state.codePreviewBorderResultComponent);
  state.codePreviewBorderShell = shell;
  state.codePreviewBorderTheme = theme;
  return shell;
}

function renderCodePreviewResult<TState, TArgs>(
  mode: ToolCallBackgroundMode,
  context: ToolRenderContext<TState, TArgs>,
  theme: Theme,
  render: (context: ToolRenderContext<TState, TArgs>) => Component,
): Component {
  const timing = updateToolCallTiming(context);
  if (mode !== "border") {
    if (!timing?.label && !isToolCallTimingOnlyRender(timingState(context))) return render(context);
    return renderTimedResultFooter(context, theme, render, timing?.label);
  }
  const state = borderState(context);
  const timingOnly = context.isPartial === true && isToolCallTimingOnlyRender(state);
  const reusedResult = timingOnly ? state.codePreviewBorderResultComponent : undefined;
  const resultComponent =
    reusedResult ??
    renderWithBorderSlot(state, "result", () =>
      render(withLastComponent(context, state.codePreviewBorderResultComponent)),
    );
  state.codePreviewBorderResultComponent = resultComponent;
  if (
    state.codePreviewBorderShell instanceof BorderedToolCall &&
    state.codePreviewBorderTheme === theme
  ) {
    syncBorderShellChrome(state.codePreviewBorderShell, state, context, timing?.label);
    if (!reusedResult) state.codePreviewBorderShell.setResult(resultComponent);
  } else {
    const shell = new BorderedToolCall(theme, state);
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
