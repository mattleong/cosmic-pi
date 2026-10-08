import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { collectBoundedText } from "./bounded-text.ts";
import { JsonHttpError } from "./errors.ts";

export interface JsonHttpRequest<S extends Schema.ConstraintDecoder<unknown, unknown>> {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  /** The provider-local decoder for successful response bodies. */
  readonly responseSchema: S;
  /** Optional hard cap applied before buffering the response body. */
  readonly maxResponseBytes?: number;
}

interface JsonHttpAcceptedResponse<A> {
  readonly _tag: "Accepted";
  readonly status: number;
  readonly body: A;
}

interface JsonHttpRejectedResponse {
  readonly _tag: "Rejected";
  readonly status: number;
}

type JsonHttpResponse<A> = JsonHttpAcceptedResponse<A> | JsonHttpRejectedResponse;

export type IsAny<A> = 0 extends 1 & A ? true : false;

/** A response decoder whose decoded type is concrete rather than `any` or `unknown`. */
export type JsonHttpResponseSchema<A, R> =
  IsAny<A> extends true ? never : unknown extends A ? never : Schema.ConstraintDecoder<A, R>;

/** A request whose decoded response type is concrete rather than `any` or `unknown`. */
type JsonHttpRequestInput<A, R> = JsonHttpRequest<JsonHttpResponseSchema<A, R>>;

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

const jsonHttpError = (operation: JsonHttpError["operation"], message: string) => () =>
  new JsonHttpError({ operation, message });
const bodyEncodeError = jsonHttpError(
  "encode",
  "HTTP request body did not match the expected schema.",
);
const responseReadError = jsonHttpError("response", "Unable to read HTTP response.");
export const responseDecodeError = jsonHttpError(
  "decode",
  "HTTP response did not match the expected schema.",
);
const responseTooLarge = jsonHttpError("response", "HTTP response exceeded its byte limit.");

/** One client transport; `jsonBody` is the already schema-encoded JSON request body. */
type JsonHttpExecute = <A, R>(
  input: JsonHttpRequestInput<A, R>,
  jsonBody?: Schema.Json,
) => Effect.Effect<JsonHttpResponse<A>, JsonHttpError, R>;

/** Builds the live and test clients over one transport, schema-encoding JSON bodies once. */
export const makeJsonHttpClient = (execute: JsonHttpExecute): JsonHttpClientContract => ({
  request: (input) => execute(input),
  requestJson: (input, bodySchema, body) =>
    Schema.encodeEffect(Schema.encodeTo(Schema.Json)(bodySchema))(body).pipe(
      Effect.mapError(bodyEncodeError),
      Effect.flatMap((jsonBody) => execute(input, jsonBody)),
    ),
});

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
        if (jsonBody !== undefined)
          outgoing = yield* HttpClientRequest.bodyJson(outgoing, jsonBody).pipe(
            Effect.mapError(bodyEncodeError),
          );
        const response = yield* client.execute(outgoing).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(jsonHttpError("request", "HTTP request failed.")),
          Effect.withSpan("pi-cosmic-core.http.json.request", {
            attributes: { "http.request.method": input.method ?? "GET" },
          }),
        );
        const maximumBytes = input.maxResponseBytes;
        // One text read and one JSON decode for every request, so a malformed body is a
        // decode failure whether or not it is bounded.
        const text = yield* maximumBytes === undefined
          ? response.text.pipe(Effect.mapError(responseReadError))
          : Number.isSafeInteger(maximumBytes) && maximumBytes > 0
            ? collectBoundedText(
                response.stream.pipe(Stream.mapError(responseReadError)),
                maximumBytes,
                responseTooLarge,
              )
            : Effect.fail(responseTooLarge());
        if (response.status < 200 || response.status >= 300)
          return { _tag: "Rejected", status: response.status } satisfies JsonHttpRejectedResponse;
        const body = yield* Schema.decodeEffect(Schema.fromJsonString(input.responseSchema))(
          text,
        ).pipe(
          Effect.mapError(responseDecodeError),
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
      return JsonHttpClient.of(makeJsonHttpClient(execute));
    }),
  );
}
