import type * as Layer from "effect/Layer";
import { CodePreviewSchedulerService } from "pi-code-previews";

/** Native Pi owns MCP resources; this runtime owns only presentation scheduling. */
export const mcpPreviewApplicationLayer = CodePreviewSchedulerService.layer;
export type McpPreviewApplication = Layer.Success<typeof mcpPreviewApplicationLayer>;
export type McpPreviewRuntimeError = Layer.Error<typeof mcpPreviewApplicationLayer>;
