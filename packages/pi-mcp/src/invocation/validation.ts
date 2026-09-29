import * as Effect from "effect/Effect";
import {
  MCP_INPUT_UNCHECKED_NOTICE,
  MCP_VALIDATION_NOTICES,
} from "../results/validation-notices.ts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { JsonSchemaValidatorContract } from "../boundary/schema-validator.ts";
import { boundaryError, type McpBoundaryError } from "../client/errors.ts";
import { MCP_BOUNDARY_LIMITS, type McpReply } from "../client/model.ts";
import type { McpOperation } from "../connection/model.ts";
import type { McpDiscoveryContract, McpMetadataSnapshot } from "../discovery/model.ts";
import { McpGatewayRequestSchema, type McpGatewayRequest } from "../tools/model.ts";
import { isSupportedJsonSchema, snapshotBoundedJson } from "../validation/schema-policy.ts";
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

type ToolCallInput = Extract<McpGatewayRequest, { readonly action: "tools.call" }>;

/** Everything one call takes from one immutable metadata entry, checked before dispatch. */
const prepareCall = (
  snapshot: McpMetadataSnapshot,
  operation: McpOperation,
  input: ToolCallInput,
  validate: McpValidate,
) =>
  Effect.gen(function* () {
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
    // A schema this client cannot use (OpenAPI nullable, an unmarked draft-07 tuple) is the
    // server's to enforce. Refusing would blame the caller for the server's schema.
    const inputChecked = isSupportedJsonSchema(inputSchema);
    if (inputChecked) yield* validate(inputSchema, arguments_, "not-sent");
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
    return {
      arguments: arguments_,
      outputSchema,
      headers,
      notices: inputChecked ? [] : [MCP_INPUT_UNCHECKED_NOTICE],
    };
  });

export const invokeTool = (
  operation: McpOperation,
  input: ToolCallInput,
  discovery: McpDiscoveryContract,
  validate: McpValidate,
): Effect.Effect<McpInvocationReply, McpBoundaryError> =>
  Effect.gen(function* () {
    const snapshot = yield* discovery.ensure(operation);
    yield* operation.checkCurrent;
    let call = yield* prepareCall(snapshot, operation, input, validate);
    const send = (prepared: typeof call) =>
      Effect.andThen(
        operation.checkCurrent,
        operation.request(
          { action: "tools.call", tool: input.tool, arguments: prepared.arguments },
          prepared.headers === undefined ? undefined : { parameterHeaders: prepared.headers },
        ),
      );
    const reply = yield* send(call).pipe(
      Effect.catchIf(
        // SEP-2243 requires this rejection before the tool runs, so nothing executed and the
        // mirrored headers came from stale metadata. Refresh it and retry once against the
        // new definition, which then also supplies the output contract.
        (error) =>
          error.reason === "rpc-header-mismatch" &&
          error.outcome === "completed" &&
          call.headers !== undefined,
        () =>
          Effect.gen(function* () {
            const refreshed = yield* discovery.refresh(operation);
            yield* operation.checkCurrent;
            call = yield* prepareCall(refreshed, operation, input, validate);
            return yield* send(call);
          }),
      ),
    );
    const { outputSchema } = call;
    const inputNotices = call.notices;
    yield* operation.checkCurrent;
    const result = reply.result;
    // Tool-error payloads need not satisfy the tool's successful-output contract.
    if (outputSchema === undefined || (isJsonObject(result) && result.isError === true))
      return inputNotices.length === 0 ? { reply } : { reply, notices: inputNotices };
    const structuredContent = isJsonObject(result) ? result.structuredContent : undefined;
    const validation =
      structuredContent === undefined
        ? Effect.fail(boundaryError("protocol", "completed", "MCP structured output is missing."))
        : validate(outputSchema, structuredContent, "completed");
    const validationResult = yield* validation.pipe(Effect.result);
    yield* operation.checkCurrent;
    if (validationResult._tag === "Success")
      return inputNotices.length === 0
        ? { reply, outputValidation: "passed" }
        : { reply, outputValidation: "passed", notices: inputNotices };
    // A local validator failure says nothing about whether remote output matches.
    return {
      reply,
      outputValidation: validationResult.failure.kind === "protocol" ? "failed" : "unavailable",
      notices: [
        validationResult.failure.kind === "protocol"
          ? MCP_VALIDATION_NOTICES.failed.invocation
          : MCP_VALIDATION_NOTICES.unavailable.invocation,
        ...inputNotices,
      ],
    };
  });
