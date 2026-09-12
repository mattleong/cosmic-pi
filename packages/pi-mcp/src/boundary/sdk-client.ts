import {
  Client,
  withInputRequired,
  type InputRequiredResult,
  type Request,
  type RequestOptions,
  type StandardSchemaV1,
  type CallToolResult,
  type CompleteResult,
  type GetPromptResult,
  type ListPromptsResult,
  type ListResourcesResult,
  type ListResourceTemplatesResult,
  type ListToolsResult,
  type ReadResourceResult,
} from "@modelcontextprotocol/client";
import {
  CallToolResultSchema,
  CompleteResultSchema,
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
  type McpConnection,
  type McpInstructions,
  type McpDispatchOptions,
} from "../client/model.ts";
import { encodeMcpHeaderValue } from "../invocation/parameter-headers.ts";
import { prefixBytes } from "../results/normalize.ts";
import { negotiationOptions } from "./mcp-protocol/select.ts";

/** Validate standard identity headers before transport dispatch evidence is recorded. */
export const preflightSdkHeaders = (input: McpRequest) =>
  Effect.try({
    try: () => {
      const name =
        input.action === "tools.call"
          ? input.tool
          : input.action === "prompts.get"
            ? input.prompt
            : input.action === "resources.read"
              ? input.uri
              : input.action === "completion.complete"
                ? input.ref.type === "ref/prompt"
                  ? input.ref.name
                  : input.ref.uri
                : undefined;
      if (name !== undefined) encodeMcpHeaderValue(name);
    },
    catch: () =>
      boundaryError("invalid-input", "not-sent", "MCP standard header value is invalid."),
  });

/** Discard oversized optional guidance without rejecting an otherwise useful connection. */
export const boundedSdkInstructions = (text: string | undefined): McpInstructions | undefined => {
  if (text === undefined) return undefined;
  const prefix = prefixBytes(text, MCP_BOUNDARY_LIMITS.instructionsBytes);
  return Object.freeze({ text: prefix, truncated: prefix.length < text.length });
};

/** Called once after initialization, never on an application request. */
export const sdkHandshake = (client: Client) =>
  Effect.try({
    try: (): Pick<McpConnection, "protocolVersion" | "instructions"> =>
      Object.freeze({
        protocolVersion: client.getNegotiatedProtocolVersion(),
        instructions: boundedSdkInstructions(client.getInstructions()),
      }),
    catch: () => boundaryError("connection", "not-sent", "Unable to read MCP handshake metadata."),
  });

/** Keep remote schema compilation out of the SDK's synchronous high-level paths. */
export const makeSdkClient = (protocol?: "auto" | "legacy", probeTimeoutMs?: number) =>
  Effect.try({
    try: () =>
      new Client(
        { name: "pi-mcp", version: "0.2.0" },
        {
          capabilities: {},
          versionNegotiation: negotiationOptions(protocol, probeTimeoutMs),
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
  options: RequestOptions & McpDispatchOptions,
): Promise<Output | InputRequiredResult> => {
  // Both modules are the SDK's public 2.0 schemas. pnpm can expose their identical
  // Standard Schema declarations through two type identities, so only this typed seam
  // bridges the compiler while retaining the SDK schema and validator implementation.
  // SAFETY: each caller passes an SDK 2.0 result schema whose public Standard Schema
  // contract is preserved; this cast only reconciles duplicate declaration identities.
  const clientSchema = schema as StandardSchemaV1<unknown, Output>;
  const multiRound =
    client.getNegotiatedProtocolVersion() === "2026-07-28" &&
    (request.method === "tools/call" ||
      request.method === "resources/read" ||
      request.method === "prompts/get");
  let params = { ...request.params };
  if (multiRound) params = { ...params, ...options.continuation };
  let meta = { ...request.params?._meta };
  if (options.logLevel) meta = { ...meta, "io.modelcontextprotocol/logLevel": options.logLevel };
  if (multiRound && options.elicitation)
    meta = {
      ...meta,
      "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } },
    };
  params = { ...params, _meta: meta };
  return multiRound
    ? client.request({ ...request, params }, withInputRequired(clientSchema), {
        ...options,
        allowInputRequired: true,
      })
    : client.request({ ...request, params }, clientSchema, options);
};

type SdkResult =
  | CompleteResult
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
  nativeOptions: RequestOptions,
  dispatchOptions?: McpDispatchOptions,
): Promise<SdkResult | InputRequiredResult> => {
  const options = { ...nativeOptions, ...dispatchOptions };
  switch (input.action) {
    case "completion.complete":
      return requestWithSdkSchema<CompleteResult>(
        client,
        {
          method: "completion/complete",
          params: input.context
            ? { ref: input.ref, argument: input.argument, context: input.context }
            : { ref: input.ref, argument: input.argument },
        },
        CompleteResultSchema,
        options,
      );
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
