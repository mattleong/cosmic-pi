import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

export class StreamingHttpError extends Schema.TaggedErrorClass<StreamingHttpError>()(
  "StreamingHttpError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface StreamingHttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly jsonBody?: unknown;
}

export interface StreamingHttpResponse {
  readonly status: number;
  readonly body: Stream.Stream<Uint8Array, StreamingHttpError>;
  /** Consume and release an otherwise-unused response body. */
  readonly discard: Effect.Effect<void, StreamingHttpError>;
}

export interface StreamingHttpClientShape {
  readonly request: (
    request: StreamingHttpRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>;
}

export class StreamingHttpClient extends Context.Service<
  StreamingHttpClient,
  StreamingHttpClientShape
>()("pi-cosmic-core/platform/streaming-http/StreamingHttpClient") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const request = Effect.fn("StreamingHttpClient.request")(function* (
        input: StreamingHttpRequest,
      ) {
        let outgoing =
          input.method === "POST"
            ? HttpClientRequest.post(input.url)
            : HttpClientRequest.get(input.url);
        if (input.headers) outgoing = HttpClientRequest.setHeaders(outgoing, input.headers);
        if (input.jsonBody !== undefined) {
          outgoing = yield* HttpClientRequest.bodyJson(outgoing, input.jsonBody).pipe(
            Effect.mapError(
              () =>
                new StreamingHttpError({
                  operation: "encode",
                  message: "Streaming HTTP request body was not valid JSON.",
                }),
            ),
          );
        }
        const response = yield* client.execute(outgoing).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(
            () =>
              new StreamingHttpError({
                operation: "request",
                message: "Streaming HTTP request failed.",
              }),
          ),
          Effect.withSpan("pi-cosmic-core.http.streaming.request", {
            attributes: { "http.request.method": input.method ?? "GET" },
          }),
        );
        const body = response.stream.pipe(
          Stream.mapError(
            () =>
              new StreamingHttpError({
                operation: "stream",
                message: "Streaming HTTP response failed.",
              }),
          ),
        );
        return {
          status: response.status,
          body,
          discard: body.pipe(
            Stream.runDrain,
            Effect.withSpan("pi-cosmic-core.http.streaming.discard", {
              attributes: { "http.response.status_code": response.status },
            }),
          ),
        } satisfies StreamingHttpResponse;
      });
      return StreamingHttpClient.of({ request });
    }),
  );
}
