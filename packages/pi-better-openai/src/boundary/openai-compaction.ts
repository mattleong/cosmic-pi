import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { JsonHttpClient, mergeHeaders } from "pi-cosmic-core";
import {
  JsonObjectSchema,
  NonNegativeIntSchema,
  type OpenAICompactionCheckpoint,
  type OpenAICompactionJsonObject,
} from "../compaction/protocol.ts";

const ProviderHeadersSchema = Schema.Record(Schema.String, Schema.NullOr(Schema.String));
const AuthSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    apiKey: Schema.optional(Schema.String),
    headers: Schema.optional(ProviderHeadersSchema),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
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
    input_tokens: NonNegativeIntSchema,
    input_tokens_details: Schema.optional(Schema.Struct({ cached_tokens: NonNegativeIntSchema })),
    output_tokens: NonNegativeIntSchema,
    total_tokens: NonNegativeIntSchema,
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

const boundaryError = (operation: OpenAICompactionBoundaryError["operation"], message: string) =>
  new OpenAICompactionBoundaryError({ operation, message });
const HTTP_FAILURES = {
  encode: "OpenAI compaction request was invalid.",
  request: "OpenAI compaction request failed.",
  response: "Unable to read the OpenAI compaction response.",
  decode: "OpenAI compaction response was invalid.",
} as const;

export interface OpenAICompactRequest {
  readonly model: Model<"openai-responses">;
  readonly input: readonly OpenAICompactionJsonObject[];
  readonly instructions?: string;
  readonly serviceTier?: "priority";
}

export interface OpenAICompactResult {
  readonly output: readonly OpenAICompactionJsonObject[];
  readonly usage: NonNullable<OpenAICompactionCheckpoint["usage"]>;
}

export interface OpenAICompactionClientContract {
  readonly compact: (
    request: OpenAICompactRequest,
  ) => Effect.Effect<OpenAICompactResult, OpenAICompactionBoundaryError>;
}

type Registry = Pick<ExtensionContext["modelRegistry"], "getApiKeyAndHeaders">;

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
          const auth = yield* Schema.decodeEffect(AuthSchema)(authRaw).pipe(
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
              {
                model: request.model.id,
                input: request.input,
                ...(request.instructions && { instructions: request.instructions }),
                ...(request.serviceTier && { service_tier: request.serviceTier }),
              },
            )
            .pipe(
              Effect.mapError((error) =>
                boundaryError(error.operation, HTTP_FAILURES[error.operation]),
              ),
              Effect.withSpan("pi-better-openai.compaction.request", {
                attributes: { "http.request.method": "POST" },
              }),
            );
          if (response._tag === "Rejected")
            return yield* new OpenAICompactionBoundaryError({
              operation: "response",
              message: `OpenAI compaction failed (${response.status}).`,
              status: response.status,
            });
          const { output, usage } = response.body;
          if (!output.some((item) => item.type === "compaction"))
            return yield* boundaryError(
              "decode",
              "OpenAI compaction response did not contain a compaction item.",
            );
          return {
            output,
            usage: {
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
              ...(usage.input_tokens_details && {
                cachedInputTokens: usage.input_tokens_details.cached_tokens,
              }),
            },
          };
        });
        return OpenAICompactionClient.of({ compact });
      }),
    );
  }
}
