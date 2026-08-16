import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type AnyToolDefinition = ToolDefinition<any, any, any>;
type RendererContext = Parameters<NonNullable<AnyToolDefinition["renderCall"]>>[2];

/** Pi-owned mutable state shared by the call/result renderers for one tool execution. */
export type RendererState = RendererContext["state"];

/** Pi-owned arguments presented to an extension renderer. */
export type RendererArguments = RendererContext["args"];
