import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { AdaptableToolDefinition } from "../tools/renderer-adapter";
import type { ToolRenderContext } from "../tools/renderers/shared/types";

export interface ToolPresentationHarness {
  call(
    args: ToolRenderContext<any, any>["args"],
    overrides?: Partial<ToolRenderContext<any, any>>,
  ): Component | undefined;
  result(
    result: AgentToolResult<any>,
    overrides?: Partial<ToolRenderContext<any, any>>,
  ): Component | undefined;
  render(width?: number): string[];
  invalidate(): void;
  readonly component: Component | undefined;
  readonly context: ToolRenderContext<any, any>;
}

/** Drives the registered render callbacks, never execute; independent of any test runner. */
export function createToolPresentationHarness(
  tool: AdaptableToolDefinition,
  options: { theme: Theme; width?: number; state?: object; cwd?: string },
): ToolPresentationHarness {
  let context: ToolRenderContext<any, any> = {
    args: {},
    toolCallId: "presentation-test",
    state: options.state ?? {},
    cwd: options.cwd ?? "/project",
    executionStarted: false,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    lastComponent: undefined,
    invalidate: () => invalidate(),
  };
  let call: Component | undefined;
  let result: Component | undefined;
  let callMounted = false;
  let resultValue: AgentToolResult<any> | undefined;
  const renderCall = () => {
    const render = tool.renderCall;
    call = render?.(context.args, options.theme, {
      ...context,
      lastComponent: call,
      invalidate: () => context.invalidate(),
    });
  };
  const renderResult = () => {
    if (!resultValue) return;
    const render = tool.renderResult;
    result = render?.(
      { content: resultValue.content, details: resultValue.details },
      { expanded: context.expanded, isPartial: context.isPartial },
      options.theme,
      { ...context, lastComponent: result, invalidate: () => context.invalidate() },
    );
  };
  function invalidate() {
    call?.invalidate();
    result?.invalidate();
    // ToolExecutionComponent.invalidate rebuilds both slots, with fresh envelopes.
    if (callMounted) renderCall();
    renderResult();
  }
  return {
    call(args, overrides = {}) {
      context = { ...context, ...overrides, args, lastComponent: call };
      callMounted = true;
      renderCall();
      return call;
    },
    result(value, overrides = {}) {
      context = {
        ...context,
        executionStarted: true,
        isPartial: false,
        ...overrides,
        lastComponent: result,
      };
      resultValue = value;
      renderResult();
      return result;
    },
    render(width = options.width ?? 80) {
      return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])];
    },
    invalidate,
    get component() {
      return call ?? result;
    },
    get context() {
      return context;
    },
  };
}
