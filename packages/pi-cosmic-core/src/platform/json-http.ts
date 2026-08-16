import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
}

const acceptsSuccessStatus = (status: number) => status >= 200 && status < 300;
const jsonHttpError = (operation: JsonHttpError["operation"], message: string) => () =>
  new JsonHttpError({ operation, message });
const responseReadError = jsonHttpError("response", "Unable to read HTTP response.");

export class JsonHttpClient extends Context.Service<JsonHttpClient, JsonHttpClientContract>()(
  "pi-cosmic-core/platform/json-http/JsonHttpClient",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request: JsonHttpClientContract["request"] = Effect.fn("JsonHttpClient.request")(
        function* <A, R>(input: JsonHttpRequestInput<A, R>) {
          let outgoing =
            input.method === "POST"
              ? HttpClientRequest.post(input.url)
              : HttpClientRequest.get(input.url);
          if (input.headers) outgoing = HttpClientRequest.setHeaders(outgoing, input.headers);
          if (input.formBody) outgoing = HttpClientRequest.bodyUrlParams(outgoing, input.formBody);

          const response = yield* client.execute(outgoing).pipe(
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            Effect.mapError(jsonHttpError("request", "HTTP request failed.")),
            Effect.withSpan("pi-cosmic-core.http.json.request", {
              attributes: { "http.request.method": input.method ?? "GET" },
            }),
          );
          if (!(input.acceptStatus ?? acceptsSuccessStatus)(response.status)) {
            const errorBody = yield* response.text.pipe(Effect.mapError(responseReadError));
            return {
              _tag: "Rejected",
              status: response.status,
              errorBody,
            } satisfies JsonHttpRejectedResponse;
          }
          const rawBody = yield* response.json.pipe(Effect.mapError(responseReadError));
          const body = yield* Schema.decodeUnknownEffect(input.responseSchema)(rawBody).pipe(
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
        },
      );
      return JsonHttpClient.of({ request });
    }),
  );
}
