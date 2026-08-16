import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { StreamingHttpClient } from "pi-cosmic-core";
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
const NonNegativeNumberSchema = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const CompactRequestSchema = Schema.Struct({
  model: Schema.String,
  input: Schema.Array(JsonObjectSchema),
  instructions: Schema.optional(Schema.String),
});
const CompactedResponseSchema = Schema.Struct({
  object: Schema.Literal("response.compaction"),
  output: Schema.Array(JsonObjectSchema),
  usage: Schema.Struct({
    input_tokens: NonNegativeNumberSchema,
    output_tokens: NonNegativeNumberSchema,
    total_tokens: NonNegativeNumberSchema,
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

const boundaryError = (
  operation: OpenAICompactionBoundaryError["operation"],
  message: string,
  status?: number,
) =>
  new OpenAICompactionBoundaryError(
    (() => {
      const objectPart1921_0 = { operation, message };
      const objectPart1921_1 =
        status === undefined ? objectPart1921_0 : { ...objectPart1921_0, status };
      return objectPart1921_1;
    })(),
  );

export interface OpenAICompactRequest {
  readonly model: Model<"openai-responses">;
  readonly input: readonly OpenAICompactionJsonObject[];
  readonly instructions?: string;
}

export interface OpenAICompactResult {
  readonly output: readonly OpenAICompactionJsonObject[];
  readonly usage: {
    readonly inputTokens: number;
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

function mergeRequestHeaders(
  ...sources: ReadonlyArray<Readonly<ProviderHeaders> | undefined>
): Record<string, string> {
  const resolved = new Map<string, { readonly name: string; readonly value: string }>();
  for (const source of sources) {
    if (!source) continue;
    for (const [name, value] of Object.entries(source)) {
      const normalized = name.toLowerCase();
      if (value === null) resolved.delete(normalized);
      else resolved.set(normalized, { name, value });
    }
  }
  return Object.fromEntries(
    Array.from(resolved.values(), ({ name, value }) => [name, value] as const),
  );
}

function hasAuthorization(headers: Readonly<Record<string, string>>): boolean {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === "authorization" && value.trim().length > 0,
  );
}

function concatenateBytes(values: readonly Uint8Array[]): Uint8Array {
  const size = values.reduce((total, value) => total + value.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

export class OpenAICompactionClient extends Context.Service<
  OpenAICompactionClient,
  OpenAICompactionClientContract
>()("pi-better-openai/boundary/openai-compaction/OpenAICompactionClient") {
  static layer(getRegistry: () => Registry) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const http = yield* StreamingHttpClient;
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
          const headers = mergeRequestHeaders(
            request.model.headers,
            auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : undefined,
            auth.headers,
          );
          if (!hasAuthorization(headers))
            return yield* boundaryError("auth", "OpenAI API credentials were unavailable.");
          const body = (() => {
            const objectPart5275_0 = { model: request.model.id, input: request.input };
            const objectPart5275_1 = request.instructions
              ? { ...objectPart5275_0, instructions: request.instructions }
              : objectPart5275_0;
            return objectPart5275_1;
          })();
          const response = yield* http
            .requestJsonRawBytes(
              {
                url: `${request.model.baseUrl.replace(/\/$/, "")}/responses/compact`,
                method: "POST",
                headers,
              },
              CompactRequestSchema,
              body,
            )
            .pipe(
              Effect.mapError(() => boundaryError("request", "OpenAI compaction request failed.")),
              Effect.withSpan("pi-better-openai.compaction.request", {
                attributes: { "http.request.method": "POST" },
              }),
            );
          if (response.status < 200 || response.status >= 300) {
            yield* response.discardRawBody.pipe(Effect.catch(() => Effect.void));
            return yield* boundaryError(
              "response",
              `OpenAI compaction failed (${response.status}).`,
              response.status,
            );
          }
          const chunks = yield* response.rawBody.pipe(
            Stream.runCollect,
            Effect.mapError(() =>
              boundaryError("response", "Unable to read the OpenAI compaction response."),
            ),
          );
          const text = yield* Effect.try({
            try: () => new TextDecoder().decode(concatenateBytes(chunks)),
            catch: () => boundaryError("decode", "OpenAI compaction response was not text."),
          });
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(CompactedResponseSchema),
          )(text).pipe(
            Effect.mapError(() =>
              boundaryError("decode", "OpenAI compaction response was invalid."),
            ),
            Effect.withSpan("pi-better-openai.compaction.decode", {
              attributes: { "http.response.status_code": response.status },
            }),
          );
          if (!decoded.output.some((item) => item.type === "compaction"))
            return yield* boundaryError(
              "decode",
              "OpenAI compaction response did not contain a compaction item.",
            );
          return {
            output: decoded.output,
            usage: {
              inputTokens: decoded.usage.input_tokens,
              outputTokens: decoded.usage.output_tokens,
              totalTokens: decoded.usage.total_tokens,
            },
          };
        });
        return OpenAICompactionClient.of({ compact });
      }),
    );
  }
}
