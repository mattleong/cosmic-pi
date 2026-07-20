// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { JsonHttpClient, StreamingHttpClient } from "../index.ts";
import { makeCapturedTracer } from "../testing.ts";

const clientLayer = (body: BodyInit, status = 200) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status }))),
    ),
  );

it.effect("decodes JSON responses through the workspace adapter", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    expect(yield* http.request({ url: "https://example.invalid" })).toEqual({
      status: 200,
      body: { ok: true },
    });
  }).pipe(Effect.provide(JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":true}'))))),
);

it.effect("captures stable HTTP spans without URLs, bodies, or credentials", () => {
  const captured = makeCapturedTracer();
  const secret = "Bearer sk-secret https://secret.invalid/private";
  return Effect.gen(function* () {
    yield* JsonHttpClient.use((http) =>
      http.request({ url: "https://secret.invalid/private", headers: { authorization: secret } }),
    ).pipe(Effect.provide(JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":true}')))));
    yield* StreamingHttpClient.use((http) =>
      http
        .request({ url: "https://secret.invalid/private", headers: { authorization: secret } })
        .pipe(Effect.flatMap((response) => response.discard)),
    ).pipe(Effect.provide(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer("stream")))));
    const names = captured.spans.map((span) => span.name);
    expect(names).toContain("pi-cosmic-core.http.json.request");
    expect(names).toContain("pi-cosmic-core.http.json.decode");
    expect(names).toContain("pi-cosmic-core.http.streaming.request");
    expect(names).toContain("pi-cosmic-core.http.streaming.discard");
    const telemetry = JSON.stringify(
      captured.spans.map((span) => ({ name: span.name, attributes: [...span.attributes] })),
    );
    expect(telemetry).not.toContain("secret.invalid");
    expect(telemetry).not.toContain("sk-secret");
    expect(telemetry).not.toContain("private");
  }).pipe(Effect.provide(captured.layer));
});

it.effect("maps invalid JSON without exposing response contents", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(http.request({ url: "https://example.invalid" }));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(String(result.failure)).not.toContain("secret-body");
  }).pipe(Effect.provide(JsonHttpClient.layer.pipe(Layer.provide(clientLayer("secret-body"))))),
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
    const layer = JsonHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    const result = yield* JsonHttpClient.use((http) =>
      Effect.result(http.request({ url: "https://secret.invalid/private" })),
    ).pipe(Effect.provide(layer));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).not.toContain("secret.invalid");
      expect(String(result.failure)).not.toContain("transport cause");
    }
  }),
);

it.effect("safely rejects non-JSON streaming request bodies before transport", () =>
  Effect.gen(function* () {
    let executions = 0;
    const client = HttpClient.make((request) => {
      executions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const layer = StreamingHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    const result = yield* StreamingHttpClient.use((http) =>
      Effect.result(
        http.request({ url: "https://example.invalid", method: "POST", jsonBody: cyclic }),
      ),
    ).pipe(Effect.provide(layer));
    expect(result._tag).toBe("Failure");
    expect(executions).toBe(0);
  }),
);

it.effect("streams and discards response bodies", () =>
  Effect.gen(function* () {
    const http = yield* StreamingHttpClient;
    const response = yield* http.request({ url: "https://example.invalid" });
    const text = yield* response.body.pipe(
      Stream.decodeText,
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    expect(text).toBe("stream");
    const second = yield* http.request({ url: "https://example.invalid" });
    yield* second.discard;
  }).pipe(Effect.provide(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer("stream"))))),
);

it.effect("maps a mid-stream failure without exposing its cause", () =>
  Effect.gen(function* () {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("secret stream failure"));
      },
    });
    const result = yield* StreamingHttpClient.use((http) =>
      Effect.gen(function* () {
        const response = yield* http.request({ url: "https://example.invalid" });
        return yield* Effect.result(response.body.pipe(Stream.runDrain));
      }),
    ).pipe(Effect.provide(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer(source)))));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(String(result.failure)).not.toContain("secret stream");
  }),
);

it.effect("cancels a response stream when its consumer is interrupted", () =>
  Effect.gen(function* () {
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancellations++;
      },
    });
    yield* StreamingHttpClient.use((http) =>
      Effect.gen(function* () {
        const response = yield* http.request({ url: "https://example.invalid" });
        const consumer = yield* response.body.pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(consumer);
      }),
    ).pipe(
      Effect.provide(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer(source)))),
      Effect.scoped,
    );
    expect(cancellations).toBe(1);
  }),
);

it.effect("interrupts an in-flight transport effect", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let finalized = 0;
    const client = HttpClient.make(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => finalized++)),
      ),
    );
    const layer = JsonHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    const fiber = yield* JsonHttpClient.use((http) =>
      http.request({ url: "https://example.invalid" }),
    ).pipe(Effect.provide(layer), Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(finalized).toBe(1);
  }).pipe(Effect.scoped),
);
