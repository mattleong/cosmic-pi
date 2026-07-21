import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { StreamingHttpError } from "./errors.ts";

export interface StreamingHttpRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
}

export interface StreamingHttpResponse {
  readonly status: number;
  /** Raw response bytes for provider streaming protocol parsers. */
  readonly rawBody: Stream.Stream<Uint8Array, StreamingHttpError>;
  /** Consume and release otherwise-unused raw response bytes. */
  readonly discardRawBody: Effect.Effect<void, StreamingHttpError>;
}

type IsAny<A> = 0 extends 1 & A ? true : false;

export type StreamingJsonBodyCodec<A, E, R> =
  IsAny<E> extends true
    ? never
    : undefined extends E
      ? never
      : Schema.ConstraintCodec<A, E, unknown, R>;

export interface StreamingHttpClientShape {
  readonly requestRawBytes: (
    request: StreamingHttpRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>;
  readonly requestJsonRawBytes: <A, E, R>(
    request: StreamingHttpRequest,
    bodySchema: StreamingJsonBodyCodec<A, E, R>,
    body: A,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError, R>;
}

export const encodeStreamingJsonBody = <A, E, R>(
  bodySchema: StreamingJsonBodyCodec<A, E, R>,
  body: A,
): Effect.Effect<Schema.Json, StreamingHttpError, R> =>
  Schema.encodeEffect(bodySchema)(body).pipe(
    Effect.flatMap((encodedBody) => Schema.decodeUnknownEffect(Schema.Json)(encodedBody)),
    Effect.mapError(
      () =>
        new StreamingHttpError({
          operation: "encode",
          message: "Streaming HTTP request body did not match the expected schema.",
        }),
    ),
  );

type StreamingRequestBody =
  | { readonly _tag: "None" }
  | { readonly _tag: "Json"; readonly value: Schema.Json };

export class StreamingHttpClient extends Context.Service<
  StreamingHttpClient,
  StreamingHttpClientShape
>()("pi-cosmic-core/platform/streaming-http/StreamingHttpClient") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const execute = Effect.fn("StreamingHttpClient.execute")(function* (
        input: StreamingHttpRequest,
        body: StreamingRequestBody,
      ) {
        let outgoing =
          input.method === "POST"
            ? HttpClientRequest.post(input.url)
            : HttpClientRequest.get(input.url);
        if (input.headers) outgoing = HttpClientRequest.setHeaders(outgoing, input.headers);
        if (body._tag === "Json") {
          outgoing = yield* HttpClientRequest.bodyJson(outgoing, body.value).pipe(
            Effect.mapError(
              () =>
                new StreamingHttpError({
                  operation: "encode",
                  message: "Streaming HTTP request body could not be encoded.",
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
        const rawBody = response.stream.pipe(
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
          rawBody,
          discardRawBody: rawBody.pipe(
            Stream.runDrain,
            Effect.withSpan("pi-cosmic-core.http.streaming.discard", {
              attributes: { "http.response.status_code": response.status },
            }),
          ),
        } satisfies StreamingHttpResponse;
      });
      const requestRawBytes: StreamingHttpClientShape["requestRawBytes"] = (input) =>
        execute(input, { _tag: "None" });
      const requestJsonRawBytes: StreamingHttpClientShape["requestJsonRawBytes"] = (
        input,
        bodySchema,
        body,
      ) =>
        encodeStreamingJsonBody(bodySchema, body).pipe(
          Effect.flatMap((encodedBody) => execute(input, { _tag: "Json", value: encodedBody })),
        );
      return StreamingHttpClient.of({ requestRawBytes, requestJsonRawBytes });
    }),
  );
}
