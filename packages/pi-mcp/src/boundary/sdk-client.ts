import {
  Client,
  type Request,
  type RequestOptions,
  type StandardSchemaV1,
  type CallToolResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from "@modelcontextprotocol/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boundaryError } from "../client/errors.ts";
import {
  MCP_BOUNDARY_LIMITS,
  McpReplySchema,
  McpRequestSchema,
  type McpReply,
  type McpRequest,
} from "../client/model.ts";

/** Keep remote schema compilation out of the SDK's synchronous high-level paths. */
export const makeSdkClient = () =>
  Effect.try({
    try: () =>
      new Client(
        { name: "pi-mcp", version: "0.2.0" },
        {
          capabilities: {},
          versionNegotiation: { mode: "legacy" },
          inputRequired: { autoFulfill: false },
          jsonSchemaValidator: {
            getValidator: () => {
              throw new Error("Remote schemas require isolated application validation.");
            },
          },
        },
      ),
    catch: () => boundaryError("connection", "not-sent", "Unable to initialize MCP client."),
  });

/** These are SDK-exported wire schemas, not application-authored Zod schemas. */
interface SdkSchemaHandle {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
  };
}

const requestWithSdkSchema = <Output>(
  client: Client,
  request: Request,
  schema: SdkSchemaHandle,
  options: RequestOptions,
): Promise<Output> => {
  // Both modules are the SDK's public 2.0 schemas. pnpm can expose their identical
  // Standard Schema declarations through two type identities, so only this typed seam
  // bridges the compiler while retaining the SDK schema and validator implementation.
  // SAFETY: each caller passes an SDK 2.0 result schema whose public Standard Schema
  // contract is preserved; this cast only reconciles duplicate declaration identities.
  const clientSchema = schema as StandardSchemaV1<unknown, Output>;
  return client.request(request, clientSchema, options);
};

type SdkResult =
  | ListToolsResult
  | CallToolResult
  | ListResourcesResult
  | ListResourceTemplatesResult
  | ReadResourceResult
  | ListPromptsResult
  | GetPromptResult;

export const executeSdkRequest = (
  client: Client,
  input: McpRequest,
  options: RequestOptions,
): Promise<SdkResult> => {
  switch (input.action) {
    case "tools.list":
      return requestWithSdkSchema<ListToolsResult>(
        client,
        {
          method: "tools/list",
          params: input.cursor === undefined ? {} : { cursor: input.cursor },
        },
        ListToolsResultSchema,
        options,
      );
    case "tools.call":
      return requestWithSdkSchema<CallToolResult>(
        client,
        { method: "tools/call", params: { name: input.tool, arguments: input.arguments ?? {} } },
        CallToolResultSchema,
        options,
      );
    case "resources.list":
      return requestWithSdkSchema<ListResourcesResult>(
        client,
        {
          method: "resources/list",
          params: input.cursor === undefined ? {} : { cursor: input.cursor },
        },
        ListResourcesResultSchema,
        options,
      );
    case "resources.templates":
      return requestWithSdkSchema<ListResourceTemplatesResult>(
        client,
        {
          method: "resources/templates/list",
          params: input.cursor === undefined ? {} : { cursor: input.cursor },
        },
        ListResourceTemplatesResultSchema,
        options,
      );
    case "resources.read":
      return requestWithSdkSchema<ReadResourceResult>(
        client,
        { method: "resources/read", params: { uri: input.uri } },
        ReadResourceResultSchema,
        options,
      );
    case "prompts.list":
      return requestWithSdkSchema<ListPromptsResult>(
        client,
        {
          method: "prompts/list",
          params: input.cursor === undefined ? {} : { cursor: input.cursor },
        },
        ListPromptsResultSchema,
        options,
      );
    case "prompts.get":
      return requestWithSdkSchema<GetPromptResult>(
        client,
        { method: "prompts/get", params: { name: input.prompt, arguments: input.arguments ?? {} } },
        GetPromptResultSchema,
        options,
      );
  }
  throw new Error("Unsupported MCP request action.");
};

export const decodeMcpRequest = <Input>(value: Input) =>
  Schema.decodeUnknownEffect(McpRequestSchema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => boundaryError("invalid-input", "not-sent", "Invalid MCP request.")),
    Effect.flatMap((input) =>
      Schema.encodeEffect(Schema.fromJsonString(McpRequestSchema))(input).pipe(
        Effect.mapError(() =>
          boundaryError("invalid-input", "not-sent", "MCP request is not serializable."),
        ),
        Effect.map((json) => new TextEncoder().encode(json).byteLength),
        Effect.flatMap((bytes) =>
          bytes <= MCP_BOUNDARY_LIMITS.requestBytes
            ? Effect.succeed(input)
            : Effect.fail(
                boundaryError("invalid-input", "not-sent", "MCP request exceeds its byte limit."),
              ),
        ),
      ),
    ),
  );

/** Completion evidence is preserved even when the application projection rejects a reply. */
export const decodeMcpReply = <Value>(
  action: McpRequest["action"],
  value: Value,
): Effect.Effect<McpReply, import("../client/errors.ts").McpBoundaryError> =>
  Schema.decodeUnknownEffect(McpReplySchema)({ action, outcome: "completed", result: value }).pipe(
    Effect.mapError(() =>
      boundaryError("protocol", "completed", "MCP returned an invalid result."),
    ),
  );
