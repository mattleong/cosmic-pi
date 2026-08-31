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

export interface StreamingHttpClientContract {
  readonly requestRawBytes: (
    request: StreamingHttpRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>;
  readonly requestJsonRawBytes: <A, E, R>(
    request: StreamingHttpRequest,
    bodySchema: StreamingJsonBodyCodec<A, E, R>,
    body: A,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError, R>;
}

const streamingHttpError = (operation: StreamingHttpError["operation"], message: string) => () =>
  new StreamingHttpError({ operation, message });

export class StreamingHttpClient extends Context.Service<
  StreamingHttpClient,
  StreamingHttpClientContract
>()("pi-cosmic-core/platform/streaming-http/StreamingHttpClient") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const execute = Effect.fn("StreamingHttpClient.execute")(function* (
        input: StreamingHttpRequest,
        body?: Schema.Json,
      ) {
        let outgoing = HttpClientRequest.make(input.method ?? "GET")(input.url, {
          headers: input.headers,
        });
        if (body !== undefined) {
          outgoing = yield* HttpClientRequest.bodyJson(outgoing, body).pipe(
            Effect.mapError(
              streamingHttpError("encode", "Streaming HTTP request body could not be encoded."),
            ),
          );
        }
        const response = yield* client.execute(outgoing).pipe(
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(streamingHttpError("request", "Streaming HTTP request failed.")),
          Effect.withSpan("pi-cosmic-core.http.streaming.request", {
            attributes: { "http.request.method": input.method ?? "GET" },
          }),
        );
        const rawBody = response.stream.pipe(
          Stream.mapError(streamingHttpError("stream", "Streaming HTTP response failed.")),
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
      const requestRawBytes: StreamingHttpClientContract["requestRawBytes"] = (input) =>
        execute(input);
      const requestJsonRawBytes: StreamingHttpClientContract["requestJsonRawBytes"] = (
        input,
        bodySchema,
        body,
      ) =>
        Schema.encodeEffect(Schema.encodeTo(Schema.Json)(bodySchema))(body).pipe(
          Effect.mapError(
            streamingHttpError(
              "encode",
              "Streaming HTTP request body did not match the expected schema.",
            ),
          ),
          Effect.flatMap((encodedBody) => execute(input, encodedBody)),
        );
      return StreamingHttpClient.of({ requestRawBytes, requestJsonRawBytes });
    }),
  );
}
