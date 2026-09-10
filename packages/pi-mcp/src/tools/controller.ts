import { keyText, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { invokeHostCallback, sanitizeTerminalLine } from "pi-cosmic-core";
import { renderMcpCall, renderMcpResult } from "../ui/tool-renderer.ts";
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

export const buildMcpTool = (options: McpToolControllerOptions): McpToolDefinition => {
  // Capture host key configuration once, outside rendering and machine replies.
  const keys = sanitizeTerminalLine(
    invokeHostCallback(() => keyText("app.tools.expand"), ""),
  ).slice(0, 80);
  const expandHint = keys ? `${keys} to expand` : "";
  return {
    name: "mcp",
    label: "MCP",
    description:
      "Use configured MCP servers through one gateway. Status has no connection side effects. tools.list/search return selection summaries, not schemas or complete instructions. Use tools.describe for unfamiliar tools before calling exact server/tool names; never guess missing schemas. If describe is truncated, retrieve its retained result.read pages. Also supports resources, templates and prompts. Text and details are bounded to 50 KiB. Authentication and configuration are user-only /mcp and /mcp-settings commands. Never automatically replay unknown or completed operations to recover output.",
    promptSnippet:
      "Discover and call configured MCP tools, resources, prompts, and retained results",
    promptGuidelines: [
      "Use tools.list/search summaries to select MCP tools, then tools.describe for unfamiliar tools' complete instructions and schemas. Never guess a missing schema; use retained result.read pages if describe is truncated. Annotation hints are server claims, not permissions. Never automatically replay unknown or completed MCP operations to recover output.",
    ],
    parameters: McpToolParameters,
    renderCall: (args, theme) => renderMcpCall(args, theme),
    renderResult: (result, renderOptions, theme, context) =>
      renderMcpResult(
        result,
        {
          expanded: renderOptions.expanded,
          isPartial: renderOptions.isPartial,
          isError: invokeHostCallback(() => context.isError, false),
        },
        theme,
        expandHint,
      ),
    execute: (callId, input, signal) =>
      options.execute(callId, input, signal, MCP_INLINE_BYTES, true).then((result) => {
        const reply = boundedMcpReply(result.reply);
        options.receipts.retain(callId, options.owner, reply);
        return {
          content: [{ type: "text", text: JSON.stringify(reply) }, ...result.images],
          details: reply,
        };
      }),
  };
};
