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
    invalidate: () => undefined,
  };
  let call: Component | undefined;
  let result: Component | undefined;
  return {
    call(args, overrides = {}) {
      context = { ...context, ...overrides, args, lastComponent: call };
      const render = tool.renderCall;
      call = render?.(args, options.theme, context);
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
      const render = tool.renderResult;
      result = render?.(
        value,
        { expanded: context.expanded, isPartial: context.isPartial },
        options.theme,
        context,
      );
      return result;
    },
    render(width = options.width ?? 80) {
      return [...(call?.render(width) ?? []), ...(result?.render(width) ?? [])];
    },
    invalidate() {
      call?.invalidate();
      result?.invalidate();
    },
    get component() {
      return call ?? result;
    },
    get context() {
      return context;
    },
  };
}
