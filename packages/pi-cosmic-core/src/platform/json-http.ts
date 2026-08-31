import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { JsonHttpError } from "./errors.ts";

export interface JsonHttpRequest<S extends Schema.ConstraintDecoder<unknown, unknown>> {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly formBody?: Readonly<Record<string, string>>;
  /** The provider-local decoder for successful response bodies. */
  readonly responseSchema: S;
  /** Defaults to the inclusive 200-299 range. */
  readonly acceptStatus?: (status: number) => boolean;
  /** Optional hard cap applied before buffering the response body. */
  readonly maxResponseBytes?: number;
}

export interface JsonHttpAcceptedResponse<A> {
  readonly _tag: "Accepted";
  readonly status: number;
  readonly body: A;
}

export interface JsonHttpRejectedResponse {
  readonly _tag: "Rejected";
  readonly status: number;
  /** Preserved provider response text. It is never included in errors or telemetry. */
  readonly errorBody: string;
}

export type JsonHttpResponse<A> = JsonHttpAcceptedResponse<A> | JsonHttpRejectedResponse;

type IsAny<A> = 0 extends 1 & A ? true : false;

/** A response decoder whose decoded type is concrete rather than `any` or `unknown`. */
export type JsonHttpResponseSchema<A, R> =
  IsAny<A> extends true ? never : unknown extends A ? never : Schema.ConstraintDecoder<A, R>;

/** A request whose decoded response type is concrete rather than `any` or `unknown`. */
export type JsonHttpRequestInput<A, R> = JsonHttpRequest<JsonHttpResponseSchema<A, R>>;

export interface JsonHttpClientContract {
  readonly request: <A, R>(
    input: JsonHttpRequestInput<A, R>,
  ) => Effect.Effect<JsonHttpResponse<A>, JsonHttpError, R>;
  readonly requestJson: <BodySchema extends Schema.Constraint, A, R>(
    input: JsonHttpRequestInput<A, R>,
    bodySchema: BodySchema,
    body: BodySchema["Type"],
  ) => Effect.Effect<JsonHttpResponse<A>, JsonHttpError, R | BodySchema["EncodingServices"]>;
}

const acceptsSuccessStatus = (status: number) => status >= 200 && status < 300;
const jsonHttpError = (operation: JsonHttpError["operation"], message: string) => () =>
  new JsonHttpError({ operation, message });
const responseReadError = jsonHttpError("response", "Unable to read HTTP response.");
const responseTooLarge = jsonHttpError("response", "HTTP response exceeded its byte limit.");

const readBoundedResponseText = <Error>(
  stream: Stream.Stream<Uint8Array, Error>,
  maximumBytes: number,
): Effect.Effect<string, JsonHttpError> => {
  let totalBytes = 0;
  return stream.pipe(
    Stream.mapEffect((bytes) => {
      totalBytes += bytes.byteLength;
      return totalBytes > maximumBytes ? Effect.fail(responseTooLarge()) : Effect.succeed(bytes);
    }),
    Stream.mapError((error) => (error instanceof JsonHttpError ? error : responseReadError())),
    Stream.decodeText,
    Stream.runCollect,
    Effect.map((chunks) => chunks.join("")),
  );
};

export class JsonHttpClient extends Context.Service<JsonHttpClient, JsonHttpClientContract>()(
  "pi-cosmic-core/platform/json-http/JsonHttpClient",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const execute = Effect.fn("JsonHttpClient.execute")(function* <A, R>(
        input: JsonHttpRequestInput<A, R>,
        jsonBody?: Schema.Json,
      ) {
        let outgoing = HttpClientRequest.make(input.method ?? "GET")(input.url, {
          headers: input.headers,
        });
        if (input.formBody) outgoing = HttpClientRequest.bodyUrlParams(outgoing, input.formBody);
        if (jsonBody !== undefined) {
          outgoing = yield* HttpClientRequest.bodyJson(outgoing, jsonBody).pipe(
            Effect.mapError(
              jsonHttpError("encode", "HTTP request body did not match the expected schema."),
            ),
          );
        }

        const response = yield* client.execute(outgoing).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(jsonHttpError("request", "HTTP request failed.")),
          Effect.withSpan("pi-cosmic-core.http.json.request", {
            attributes: { "http.request.method": input.method ?? "GET" },
          }),
        );
        const maximumBytes = input.maxResponseBytes;
        const readText =
          maximumBytes === undefined
            ? response.text.pipe(Effect.mapError(responseReadError))
            : Number.isSafeInteger(maximumBytes) && maximumBytes > 0
              ? readBoundedResponseText(response.stream, maximumBytes)
              : Effect.fail(responseTooLarge());
        if (!(input.acceptStatus ?? acceptsSuccessStatus)(response.status)) {
          const errorBody = yield* readText;
          return {
            _tag: "Rejected",
            status: response.status,
            errorBody,
          } satisfies JsonHttpRejectedResponse;
        }
        const rawBody =
          maximumBytes === undefined
            ? yield* response.json.pipe(Effect.mapError(responseReadError))
            : yield* readText;
        const body = yield* (
          maximumBytes === undefined
            ? Schema.decodeUnknownEffect(input.responseSchema)(rawBody)
            : Schema.decodeUnknownEffect(Schema.fromJsonString(input.responseSchema))(rawBody)
        ).pipe(
          Effect.mapError(
            jsonHttpError("decode", "HTTP response did not match the expected schema."),
          ),
          Effect.withSpan("pi-cosmic-core.http.json.decode", {
            attributes: { "http.response.status_code": response.status },
          }),
        );
        return {
          _tag: "Accepted",
          status: response.status,
          body,
        } satisfies JsonHttpAcceptedResponse<A>;
      });
      const request: JsonHttpClientContract["request"] = (input) => execute(input);
      const requestJson: JsonHttpClientContract["requestJson"] = (input, bodySchema, body) =>
        Schema.encodeEffect(Schema.encodeTo(Schema.Json)(bodySchema))(body).pipe(
          Effect.mapError(
            jsonHttpError("encode", "HTTP request body did not match the expected schema."),
          ),
          Effect.flatMap((encodedJsonBody) => execute(input, encodedJsonBody)),
        );
      return JsonHttpClient.of({ request, requestJson });
    }),
  );
}
