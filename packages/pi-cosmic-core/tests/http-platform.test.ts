import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { JsonHttpClient, provideBuiltLayer, StreamingHttpClient } from "../index.ts";
import {
  capturedTelemetrySnapshot,
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  makeCapturedTracer,
  streamingHttpTestLayer,
  streamingHttpResponse,
} from "../testing.ts";

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
    expect(
      yield* http.request({
        url: "https://example.invalid",
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    ).toEqual({
      _tag: "Accepted",
      status: 200,
      body: { ok: true },
    });
  }).pipe(provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":true}'))))),
);

it.effect("captures stable HTTP spans without URLs, bodies, or credentials", () => {
  const captured = makeCapturedTracer();
  const secret = "Bearer sk-secret https://secret.invalid/private";
  return Effect.gen(function* () {
    yield* JsonHttpClient.use((http) =>
      http.request({
        url: "https://secret.invalid/private",
        headers: { authorization: secret },
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    ).pipe(provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":true}')))));
    yield* JsonHttpClient.use((http) =>
      http.request({
        url: "https://secret.invalid/private",
        headers: { authorization: secret },
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    ).pipe(
      provideBuiltLayer(
        JsonHttpClient.layer.pipe(Layer.provide(clientLayer("provider-secret-body", 401))),
      ),
    );
    yield* StreamingHttpClient.use((http) =>
      http
        .requestRawBytes({
          url: "https://secret.invalid/private",
          headers: { authorization: secret },
        })
        .pipe(Effect.flatMap((response) => response.discardRawBody)),
    ).pipe(provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer("stream")))));
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

it.effect("maps invalid JSON without exposing response contents", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(
      http.request({
        url: "https://example.invalid",
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(String(result.failure)).not.toContain("secret-body");
  }).pipe(provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(clientLayer("secret-body"))))),
);

it.effect("maps schema decode failures without exposing decoded values", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(
      http.request({
        url: "https://example.invalid",
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe("decode");
      expect(String(result.failure)).not.toContain("secret-value");
    }
  }).pipe(
    provideBuiltLayer(
      JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":"secret-value"}'))),
    ),
  ),
);

it.effect("preserves rejected status and provider error bodies without decoding them", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const response = yield* http.request({
      url: "https://example.invalid",
      responseSchema: Schema.Struct({ ok: Schema.Boolean }),
    });
    expect(response).toEqual({
      _tag: "Rejected",
      status: 429,
      errorBody: "provider-error",
    });
  }).pipe(
    provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(clientLayer("provider-error", 429)))),
  ),
);

it.effect(
  "test HTTP responses preserve arbitrary raw rejected text and decode raw success JSON",
  () =>
    Effect.gen(function* () {
      const rejected = yield* JsonHttpClient.use((http) =>
        http.request({
          url: "https://example.invalid",
          responseSchema: Schema.Struct({ ok: Schema.Boolean }),
        }),
      ).pipe(
        provideBuiltLayer(
          jsonHttpTestLayer(() =>
            Effect.succeed(jsonHttpRawResponse(502, "<html>provider unavailable</html>")),
          ),
        ),
      );
      expect(rejected).toEqual({
        _tag: "Rejected",
        status: 502,
        errorBody: "<html>provider unavailable</html>",
      });

      const accepted = yield* JsonHttpClient.use((http) =>
        http.request({
          url: "https://example.invalid",
          responseSchema: Schema.Struct({ ok: Schema.Boolean }),
        }),
      ).pipe(
        provideBuiltLayer(
          jsonHttpTestLayer(() => Effect.succeed(jsonHttpRawResponse(200, '{"ok":true}'))),
        ),
      );
      expect(accepted).toEqual({ _tag: "Accepted", status: 200, body: { ok: true } });
    }),
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
      Effect.result(
        http.request({
          url: "https://secret.invalid/private",
          responseSchema: Schema.Struct({ ok: Schema.Boolean }),
        }),
      ),
    ).pipe(provideBuiltLayer(layer));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).not.toContain("secret.invalid");
      expect(String(result.failure)).not.toContain("transport cause");
    }
  }),
);

it.effect("encodes JSON request bodies through their schema", () =>
  Effect.gen(function* () {
    const response = yield* JsonHttpClient.use((http) =>
      http.requestJson(
        {
          url: "https://example.invalid",
          method: "POST",
          responseSchema: Schema.Struct({ ok: Schema.Boolean }),
        },
        Schema.Struct({ value: Schema.Number }),
        { value: 42 },
      ),
    ).pipe(
      provideBuiltLayer(
        jsonHttpTestLayer((input) => {
          expect(input.encodedJsonBody).toEqual({ value: 42 });
          return Effect.succeed(jsonHttpRawResponse(200, '{"ok":true}'));
        }),
      ),
    );
    expect(response).toEqual({ _tag: "Accepted", status: 200, body: { ok: true } });
  }),
);

it.effect("rejects invalid JSON request bodies before transport", () =>
  Effect.gen(function* () {
    let executions = 0;
    const client = HttpClient.make((request) => {
      executions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
    });
    const result = yield* JsonHttpClient.use((http) =>
      Effect.result(
        http.requestJson(
          {
            url: "https://example.invalid",
            method: "POST",
            responseSchema: Schema.Struct({ ok: Schema.Boolean }),
          },
          Schema.Struct({ value: Schema.Number.check(Schema.isFinite()) }),
          { value: Number.NaN },
        ),
      ),
    ).pipe(
      provideBuiltLayer(
        JsonHttpClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    );
    expect(result._tag).toBe("Failure");
    expect(executions).toBe(0);
  }),
);

it.effect("bounds JSON response buffering before decoding", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(
      http.request({
        url: "https://example.invalid",
        maxResponseBytes: 4,
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("response");
  }).pipe(provideBuiltLayer(JsonHttpClient.layer.pipe(Layer.provide(clientLayer('{"ok":true}'))))),
);

it.effect("rejects streaming request bodies that fail schema encoding before transport", () =>
  Effect.gen(function* () {
    let executions = 0;
    const client = HttpClient.make((request) => {
      executions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
    });
    const FiniteBody = Schema.Struct({ value: Schema.Number.check(Schema.isFinite()) });
    const layer = StreamingHttpClient.layer.pipe(
      Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    );
    const result = yield* StreamingHttpClient.use((http) =>
      Effect.result(
        http.requestJsonRawBytes({ url: "https://example.invalid", method: "POST" }, FiniteBody, {
          value: Number.NaN,
        }),
      ),
    ).pipe(provideBuiltLayer(layer));
    expect(result._tag).toBe("Failure");
    expect(executions).toBe(0);
  }),
);

it.effect("rejects undefined JSON encodings before production or test transport", () =>
  Effect.gen(function* () {
    // SAFETY: This deliberately invalid codec exercises rejection of a non-JSON encoded value.
    const undefinedAsJson = Schema.Undefined as typeof Schema.Undefined &
      Schema.ConstraintCodec<undefined, Schema.Json, never, never>;
    let productionExecutions = 0;
    const client = HttpClient.make((request) => {
      productionExecutions++;
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
    });
    const productionResult = yield* StreamingHttpClient.use((http) =>
      Effect.result(
        http.requestJsonRawBytes<undefined, Schema.Json, never>(
          { url: "https://example.invalid", method: "POST" },
          undefinedAsJson,
          undefined,
        ),
      ),
    ).pipe(
      provideBuiltLayer(
        StreamingHttpClient.layer.pipe(Layer.provide(Layer.succeed(HttpClient.HttpClient, client))),
      ),
    );

    let testExecutions = 0;
    const testResult = yield* StreamingHttpClient.use((http) =>
      Effect.result(
        http.requestJsonRawBytes<undefined, Schema.Json, never>(
          { url: "https://example.invalid", method: "POST" },
          undefinedAsJson,
          undefined,
        ),
      ),
    ).pipe(
      provideBuiltLayer(
        streamingHttpTestLayer(() => {
          testExecutions++;
          return Effect.succeed(streamingHttpResponse(200, Stream.empty));
        }),
      ),
    );

    expect(productionResult._tag).toBe("Failure");
    expect(testResult._tag).toBe("Failure");
    if (productionResult._tag === "Failure") {
      expect(productionResult.failure.operation).toBe("encode");
    }
    if (testResult._tag === "Failure") expect(testResult.failure.operation).toBe("encode");
    expect(productionExecutions).toBe(0);
    expect(testExecutions).toBe(0);
  }),
);

it.effect("streams and discards response bodies", () =>
  Effect.gen(function* () {
    const http = yield* StreamingHttpClient;
    const response = yield* http.requestRawBytes({ url: "https://example.invalid" });
    const text = yield* response.rawBody.pipe(
      Stream.decodeText,
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    expect(text).toBe("stream");
    const second = yield* http.requestRawBytes({ url: "https://example.invalid" });
    yield* second.discardRawBody;
  }).pipe(provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer("stream"))))),
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
        const response = yield* http.requestRawBytes({ url: "https://example.invalid" });
        return yield* Effect.result(response.rawBody.pipe(Stream.runDrain));
      }),
    ).pipe(provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer(source)))));
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
        const response = yield* http.requestRawBytes({ url: "https://example.invalid" });
        const consumer = yield* response.rawBody.pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(consumer);
      }),
    ).pipe(
      provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(clientLayer(source)))),
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
      http.request({
        url: "https://example.invalid",
        responseSchema: Schema.Struct({ ok: Schema.Boolean }),
      }),
    ).pipe(provideBuiltLayer(layer), Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(finalized).toBe(1);
  }).pipe(Effect.scoped),
);
