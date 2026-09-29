import * as Effect from "effect/Effect";
import { MCP_VALIDATION_NOTICES } from "../results/validation-notices.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { JsonSchemaValidatorContract } from "../boundary/schema-validator.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { MCP_BOUNDARY_LIMITS, type McpReply } from "../client/model.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpDiscoveryContract } from "../discovery/model.ts";
import { McpGatewayRequestSchema, type McpGatewayRequest } from "../tools/model.ts";
import { snapshotBoundedJson } from "../validation/schema-policy.ts";
import { parameterHeaders } from "./parameter-headers.ts";

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

export const decodeGatewayRequest = <Input>(
  input: Input,
): Effect.Effect<McpGatewayRequest, McpBoundaryError> =>
  Effect.try({
    try: () => snapshotBoundedJson(input, MCP_BOUNDARY_LIMITS.requestBytes),
    catch: () => boundaryError("invalid-input", "not-sent", "MCP input is not bounded plain JSON."),
  }).pipe(
    Effect.flatMap((snapshot) =>
      Schema.decodeUnknownEffect(McpGatewayRequestSchema)(
        isJsonObject(snapshot) && !Object.hasOwn(snapshot, "action")
          ? { action: "status", ...snapshot }
          : snapshot,
        { onExcessProperty: "error" },
      ).pipe(
        Effect.mapError(() =>
          boundaryError(
            "invalid-input",
            "not-sent",
            "MCP request is invalid or exceeds its limits.",
            "gateway-request-invalid",
          ),
        ),
      ),
    ),
  );

export interface McpInvocationReply {
  readonly reply: McpReply;
  readonly outputValidation?: "passed" | "failed" | "unavailable";
  readonly notices?: ReadonlyArray<string>;
}

/** The caller serializes only each helper validation, never remote work or user waits. */
export type McpValidate = JsonSchemaValidatorContract["validateJsonSchema"];

/** 2025-11-25 tasks: a required-task tool cannot run without the tasks capability we omit. */
const requiresTask = Schema.is(
  Schema.Struct({ execution: Schema.Struct({ taskSupport: Schema.Literal("required") }) }),
);

export const invokeTool = (
  operation: McpOperation,
  input: Extract<McpGatewayRequest, { readonly action: "tools.call" }>,
  discovery: McpDiscoveryContract,
  validate: McpValidate,
): Effect.Effect<McpInvocationReply, McpBoundaryError> =>
  Effect.gen(function* () {
    const snapshot = yield* discovery.ensure(operation);
    yield* operation.checkCurrent;
    const tool = snapshot.tools.find((candidate) => candidate.name === input.tool);
    if (!tool)
      return yield* boundaryError(
        "not-found",
        "not-sent",
        "MCP tool was not advertised or is not permitted.",
      );
    if (requiresTask(tool))
      return yield* boundaryError(
        "unsupported",
        "not-sent",
        "MCP tool requires task execution, which is not supported.",
      );
    // Capture this exact immutable metadata entry. A list-change or refresh after
    // dispatch must not change the output contract of the already accepted call.
    const { inputSchema, outputSchema } = tool;
    const arguments_ = input.arguments ?? {};
    yield* validate(inputSchema, arguments_, "not-sent");
    const headers =
      operation.capabilities.parameterHeaders === true
        ? yield* Effect.try({
            try: () => parameterHeaders(inputSchema, arguments_),
            catch: () =>
              boundaryError(
                "invalid-input",
                "not-sent",
                "MCP parameter headers are invalid or exceed local limits.",
              ),
          })
        : undefined;
    yield* operation.checkCurrent;
    const reply = yield* operation.request(
      {
        action: "tools.call",
        tool: input.tool,
        arguments: arguments_,
      },
      headers === undefined ? undefined : { parameterHeaders: headers },
    );
    yield* operation.checkCurrent;
    const result = reply.result;
    // Tool-error payloads need not satisfy the tool's successful-output contract.
    if (outputSchema === undefined || (isJsonObject(result) && result.isError === true))
      return { reply };
    const structuredContent = isJsonObject(result) ? result.structuredContent : undefined;
    const validation =
      structuredContent === undefined
        ? Effect.fail(boundaryError("protocol", "completed", "MCP structured output is missing."))
        : validate(outputSchema, structuredContent, "completed");
    const validationResult = yield* validation.pipe(Effect.result);
    yield* operation.checkCurrent;
    if (validationResult._tag === "Success") return { reply, outputValidation: "passed" };
    // A local validator failure says nothing about whether remote output matches.
    return {
      reply,
      outputValidation: validationResult.failure.kind === "protocol" ? "failed" : "unavailable",
      notices: [
        validationResult.failure.kind === "protocol"
          ? MCP_VALIDATION_NOTICES.failed.invocation
          : MCP_VALIDATION_NOTICES.unavailable.invocation,
      ],
    };
  });
