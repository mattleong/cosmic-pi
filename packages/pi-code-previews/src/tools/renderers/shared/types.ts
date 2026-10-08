import type {
  AgentToolResult,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RendererContext = Parameters<NonNullable<AnyToolDefinition["renderCall"]>>[2];

/** Pi's mandatory renderer context, specialized without copying its runtime shape. */
export type ToolRenderContext<
  TState = RendererContext["state"],
  TArgs = RendererContext["args"],
> = Omit<RendererContext, "state" | "args"> & { state: TState; args: TArgs };

/** Pi-owned mutable state shared by the call/result renderers for one tool execution. */
export type RendererState = RendererContext["state"];

/** Pi-owned arguments presented to an extension renderer. */
export type RendererArguments = RendererContext["args"];

/** A tool's own call and result renderers, before the shared shell composes them. */
export type PreviewRenderers = {
  readonly renderCall: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
  readonly renderResult: (
    result: AgentToolResult<any>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: ToolRenderContext<any, any>,
  ) => Component;
};
