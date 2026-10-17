import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { JsonHttpClient, provideBuiltLayer, StreamingHttpClient } from "../index.ts";
import type { StreamingHttpRequest } from "../src/platform/streaming-http.ts";
import { capturedTelemetrySnapshot, makeCapturedTracer } from "../testing.ts";

const Ok = Schema.Struct({ ok: Schema.Boolean });
const okRequest = { url: "https://example.invalid", responseSchema: Ok };
const streamRequest = (
  request: StreamingHttpRequest = { url: "https://example.invalid", method: "POST" },
) => StreamingHttpClient.use((http) => http.requestJsonRawBytes(request, Schema.Struct({}), {}));

const toClient = (source: BodyInit | HttpClient.HttpClient, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.isHttpClient(source)
      ? source
      : HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(source, { status }))),
        ),
  );
const json = (source: BodyInit | HttpClient.HttpClient, status?: number) =>
  provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(toClient(source, status))));
const streaming = (source: BodyInit | HttpClient.HttpClient) =>
  provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(toClient(source))));

it.effect("captures stable HTTP spans without URLs, bodies, or credentials", () => {
  const captured = makeCapturedTracer();
  const secret = "Bearer sk-secret https://secret.invalid/private";
  const request = {
    url: "https://secret.invalid/private",
    headers: { authorization: secret },
    responseSchema: Ok,
  };
  return Effect.gen(function* () {
    yield* JsonHttpClient.use((http) => http.request(request)).pipe(json('{"ok":true}'));
    yield* JsonHttpClient.use((http) => http.request(request)).pipe(
      json("provider-secret-body", 401),
    );
    yield* streamRequest({ url: request.url, headers: request.headers }).pipe(
      Effect.flatMap((response) => response.discardRawBody),
      streaming("stream"),
    );
    const names = captured.spans.map((span) => span.name);
    expect(names).toContain("pi-cosmic-core.http.json.request");
    expect(names).toContain("pi-cosmic-core.http.json.decode");
    expect(names).toContain("pi-cosmic-core.http.streaming.request");
    expect(names).toContain("pi-cosmic-core.http.streaming.discard");
    const telemetry = capturedTelemetrySnapshot(captured);
    expect(telemetry).not.toContain("secret.invalid");
    expect(telemetry).not.toContain("sk-secret");
    expect(telemetry).not.toContain("private");
    expect(telemetry).not.toContain("provider-secret-body");
  }).pipe(provideBuiltLayer(captured.layer));
});

it.effect.each(['{"ok":"secret-value"}'])(
  "maps malformed response %s to a decode failure with or without a byte limit",
  (body) =>
    Effect.gen(function* () {
      const http = yield* JsonHttpClient;
      for (const request of [okRequest, { ...okRequest, maxResponseBytes: 1024 }]) {
        const failure = yield* Effect.flip(http.request(request));
        expect(failure.operation).toBe("decode");
        expect(String(failure)).not.toContain("secret");
      }
    }).pipe(json(body)),
);

it.effect("maps transport failure without exposing its URL or cause", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            cause: "secret transport cause",
          }),
        }),
      ),
    );
    const result = yield* JsonHttpClient.use((http) =>
      Effect.result(http.request({ ...okRequest, url: "https://secret.invalid/private" })),
    ).pipe(json(client));
    expect(result._tag).toBe("Failure");
    if (Result.isFailure(result)) {
      expect(String(result.failure)).not.toContain("secret.invalid");
      expect(String(result.failure)).not.toContain("transport cause");
    }
  }),
);

it.effect("bounds JSON response buffering before decoding", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(http.request({ ...okRequest, maxResponseBytes: 4 }));
    expect(result._tag).toBe("Failure");
    if (Result.isFailure(result)) expect(result.failure.operation).toBe("response");
  }).pipe(json('{"ok":true}')),
);

it.effect("cancels a response stream when its consumer is interrupted", () =>
  Effect.gen(function* () {
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    });
    yield* Effect.gen(function* () {
      const response = yield* streamRequest();
      const consumer = yield* response.rawBody.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);
    }).pipe(streaming(source), Effect.scoped);
    expect(cancellations).toBe(1);
  }),
);
