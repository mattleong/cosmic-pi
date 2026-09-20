import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { JsonHttpClient, mergeHeaders } from "pi-cosmic-core";
import type { OpenAICompactionJsonObject } from "../compaction/protocol.ts";

const ProviderHeadersSchema = Schema.Record(Schema.String, Schema.NullOr(Schema.String));
const AuthSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    apiKey: Schema.optional(Schema.String),
    headers: Schema.optional(ProviderHeadersSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const NonNegativeIntegerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const CompactRequestSchema = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(JsonObjectSchema),
  instructions: Schema.optional(Schema.String),
  service_tier: Schema.optional(Schema.Literal("priority")),
});
const MAX_COMPACTION_RESPONSE_BYTES = 20 * 1024 * 1024;
const CompactedResponseSchema = Schema.Struct({
  object: Schema.Literal("response.compaction"),
  output: Schema.Array(JsonObjectSchema),
  usage: Schema.Struct({
    input_tokens: NonNegativeIntegerSchema,
    input_tokens_details: Schema.optional(
      Schema.Struct({
        cached_tokens: NonNegativeIntegerSchema,
      }),
    ),
    output_tokens: NonNegativeIntegerSchema,
    total_tokens: NonNegativeIntegerSchema,
  }),
});

export class OpenAICompactionBoundaryError extends Schema.TaggedError<OpenAICompactionBoundaryError>()(
  "OpenAICompactionBoundaryError",
  {
    operation: Schema.Literals(["auth", "encode", "request", "response", "decode"]),
    message: Schema.String,
    status: Schema.optional(Schema.Number),
  },
) {}

interface BoundaryErrorArgs {
  operation: OpenAICompactionBoundaryError["operation"];
  message: string;
  status?: number | undefined;
}

const boundaryError = (
  operation: OpenAICompactionBoundaryError["operation"],
  message: string,
  status?: number,
) => {
  const error: BoundaryErrorArgs = { operation, message };
  if (status !== undefined) error.status = status;
  return new OpenAICompactionBoundaryError(error);
};

export interface OpenAICompactRequest {
  readonly model: Model<"openai-responses">;
  readonly input: readonly OpenAICompactionJsonObject[];
  readonly instructions?: string;
  readonly serviceTier?: "priority";
}

export interface OpenAICompactResult {
  readonly output: readonly OpenAICompactionJsonObject[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
}

export interface OpenAICompactionClientContract {
  readonly compact: (
    request: OpenAICompactRequest,
  ) => Effect.Effect<OpenAICompactResult, OpenAICompactionBoundaryError>;
}

type Registry = Pick<
  Pick<ExtensionContext, "modelRegistry">["modelRegistry"],
  "getApiKeyAndHeaders"
>;

function hasAuthorization(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === "authorization" && value.trim().length > 0,
  );
}

export class OpenAICompactionClient extends Context.Service<
  OpenAICompactionClient,
  OpenAICompactionClientContract
>()("pi-better-openai/boundary/openai-compaction/OpenAICompactionClient") {
  static layer(getRegistry: () => Registry) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const http = yield* JsonHttpClient;
        const compact: OpenAICompactionClientContract["compact"] = Effect.fn(
          "OpenAICompactionClient.compact",
        )(function* (request) {
          const authRaw = yield* Effect.tryPromise({
            try: () => getRegistry().getApiKeyAndHeaders(request.model),
            catch: () => boundaryError("auth", "Unable to resolve OpenAI credentials."),
          });
          const auth = yield* Schema.decodeUnknownEffect(AuthSchema)(authRaw).pipe(
            Effect.mapError(() => boundaryError("auth", "OpenAI authentication was invalid.")),
          );
          if (!auth.ok)
            return yield* boundaryError("auth", "OpenAI authentication was unavailable.");
          const headers = mergeHeaders(
            request.model.headers,
            auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : undefined,
            auth.headers,
          );
          if (!hasAuthorization(headers))
            return yield* boundaryError("auth", "OpenAI API credentials were unavailable.");
          const body: Types.Mutable<Schema.Schema.Type<typeof CompactRequestSchema>> = {
            model: request.model.id,
            input: request.input,
          };
          if (request.instructions) body.instructions = request.instructions;
          if (request.serviceTier) body.service_tier = request.serviceTier;
          const response = yield* http
            .requestJson(
              {
                url: `${request.model.baseUrl.replace(/\/$/, "")}/responses/compact`,
                method: "POST",
                headers,
                responseSchema: CompactedResponseSchema,
                maxResponseBytes: MAX_COMPACTION_RESPONSE_BYTES,
              },
              CompactRequestSchema,
              body,
            )
            .pipe(
              Effect.mapError((error) =>
                error.operation === "encode"
                  ? boundaryError("encode", "OpenAI compaction request was invalid.")
                  : error.operation === "decode"
                    ? boundaryError("decode", "OpenAI compaction response was invalid.")
                    : error.operation === "response"
                      ? boundaryError("response", "Unable to read the OpenAI compaction response.")
                      : boundaryError("request", "OpenAI compaction request failed."),
              ),
              Effect.withSpan("pi-better-openai.compaction.request", {
                attributes: { "http.request.method": "POST" },
              }),
            );
          if (response._tag === "Rejected")
            return yield* boundaryError(
              "response",
              `OpenAI compaction failed (${response.status}).`,
              response.status,
            );
          const decoded = response.body;
          if (!decoded.output.some((item) => item.type === "compaction"))
            return yield* boundaryError(
              "decode",
              "OpenAI compaction response did not contain a compaction item.",
            );
          const usage: Types.Mutable<OpenAICompactResult["usage"]> = {
            inputTokens: decoded.usage.input_tokens,
            outputTokens: decoded.usage.output_tokens,
            totalTokens: decoded.usage.total_tokens,
          };
          if (decoded.usage.input_tokens_details)
            usage.cachedInputTokens = decoded.usage.input_tokens_details.cached_tokens;
          return { output: decoded.output, usage };
        });
        return OpenAICompactionClient.of({ compact });
      }),
    );
  }
}
