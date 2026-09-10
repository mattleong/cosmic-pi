import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  boundedMcpReply,
  type McpErrorReceipts,
  type McpActivationMarker,
} from "../boundary/host-tool-result.ts";
import { MCP_INLINE_BYTES, type McpGatewayExecution, type McpGatewayReply } from "./model.ts";

// Pi requires a JSON tool schema. The shared execution service performs closed,
// action-specific Effect Schema decoding again, including calls bypassing Pi middleware.
export const McpToolParameters = Type.Object(
  {
    action: Type.Optional(
      Type.String({
        description:
          "status (default), connect, disconnect, refresh, tools.list, tools.search, tools.describe, tools.call, resources.list, resources.templates, resources.read, prompts.list, prompts.get, or result.read",
      }),
    ),
    server: Type.Optional(Type.String({ maxLength: 128 })),
    tool: Type.Optional(Type.String({ maxLength: 1_024 })),
    query: Type.Optional(Type.String({ maxLength: 1_024 })),
    cursor: Type.Optional(Type.String({ maxLength: 8_192 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50_000 })),
    arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    uri: Type.Optional(Type.String({ maxLength: 1_024 })),
    prompt: Type.Optional(Type.String({ maxLength: 1_024 })),
    id: Type.Optional(Type.String({ maxLength: 1_024 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
    attachment: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type McpToolDefinition = ToolDefinition<typeof McpToolParameters, McpGatewayReply>;
export interface McpToolControllerOptions {
  readonly owner: McpActivationMarker;
  readonly receipts: McpErrorReceipts;
  readonly execute: <Input>(
    callId: string,
    input: Input,
    signal: AbortSignal | undefined,
    maxOutputBytes: number,
    images: boolean,
  ) => Promise<McpGatewayExecution>;
}

export const buildMcpTool = (options: McpToolControllerOptions): McpToolDefinition => ({
  name: "mcp",
  label: "MCP",
  description:
    "Use configured MCP servers through one gateway. Status has no connection side effects. Discover tools before calling exact server/tool names; retrieve resources, templates, prompts, and retained result pages. Text and details are bounded to 50 KiB. Authentication and configuration are user-only /mcp and /mcp-settings commands. Unknown execution outcomes must not be replayed automatically.",
  promptSnippet: "Discover and call configured MCP tools, resources, prompts, and retained results",
  promptGuidelines: [
    "Use mcp discovery before calling an unfamiliar MCP tool. Never automatically replay an mcp operation whose outcome is unknown.",
  ],
  parameters: McpToolParameters,
  execute: (callId, input, signal) =>
    options.execute(callId, input, signal, MCP_INLINE_BYTES, true).then((result) => {
      const reply = boundedMcpReply(result.reply);
      options.receipts.retain(callId, options.owner, reply);
      return {
        content: [{ type: "text", text: JSON.stringify(reply) }, ...result.images],
        details: reply,
      };
    }),
});
