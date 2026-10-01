import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import {
  JsonHttpClient,
  provideBuiltLayer,
  StreamingHttpClient,
  type StreamingHttpRequest,
} from "../index.ts";
import {
  capturedTelemetrySnapshot,
  jsonHttpRawResponse,
  jsonHttpTestLayer,
  makeCapturedTracer,
  streamingHttpTestLayer,
  streamingHttpResponse,
} from "../testing.ts";

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
const streaming = (source: BodyInit | HttpClient.HttpClient, status?: number) =>
  provideBuiltLayer(StreamingHttpClient.layer.pipe(Layer.provide(toClient(source, status))));
const countingClient = () => {
  let executions = 0;
  const client = HttpClient.make((request) => {
    executions++;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")));
  });
  return { client, executions: () => executions };
};

it.effect("decodes JSON responses through the workspace adapter", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    expect(yield* http.request(okRequest)).toEqual({
      _tag: "Accepted",
      status: 200,
      body: { ok: true },
    });
  }).pipe(json('{"ok":true}')),
);

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

it.effect.each([
  ["secret-body", "response"],
  ['{"ok":"secret-value"}', "decode"],
] as const)("maps unreadable response %s without exposing its contents", ([body, operation]) =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(http.request(okRequest));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.operation).toBe(operation);
      expect(String(result.failure)).not.toContain("secret");
    }
  }).pipe(json(body)),
);

it.effect("preserves rejected status and provider error bodies without decoding them", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    expect(yield* http.request(okRequest)).toEqual({
      _tag: "Rejected",
      status: 429,
      errorBody: "provider-error",
    });
  }).pipe(json("provider-error", 429)),
);

it.effect(
  "test HTTP responses preserve arbitrary raw rejected text and decode raw success JSON",
  () =>
    Effect.gen(function* () {
      const request = JsonHttpClient.use((http) => http.request(okRequest));
      const rejected = yield* request.pipe(
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

      const accepted = yield* request.pipe(
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
    const result = yield* JsonHttpClient.use((http) =>
      Effect.result(http.request({ ...okRequest, url: "https://secret.invalid/private" })),
    ).pipe(json(client));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(String(result.failure)).not.toContain("secret.invalid");
      expect(String(result.failure)).not.toContain("transport cause");
    }
  }),
);

it.effect("encodes JSON request bodies through their schema", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) => {
      expect(request.body._tag).toBe("Uint8Array");
      if (request.body._tag === "Uint8Array")
        expect(new TextDecoder().decode(request.body.body)).toBe('{"value":"42"}');
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response('{"ok":true}')));
    });
    const response = yield* JsonHttpClient.use((http) =>
      http.requestJson(
        { ...okRequest, method: "POST" },
        Schema.Struct({ value: Schema.NumberFromString }),
        { value: 42 },
      ),
    ).pipe(json(client));
    expect(response).toEqual({ _tag: "Accepted", status: 200, body: { ok: true } });
  }),
);

it.effect("rejects invalid JSON request bodies before transport", () =>
  Effect.gen(function* () {
    const counting = countingClient();
    const result = yield* JsonHttpClient.use((http) =>
      Effect.result(
        http.requestJson(
          { ...okRequest, method: "POST" },
          Schema.Struct({ value: Schema.Number.check(Schema.isFinite()) }),
          { value: Number.NaN },
        ),
      ),
    ).pipe(json(counting.client));
    expect(result._tag).toBe("Failure");
    expect(counting.executions()).toBe(0);
  }),
);

it.effect("bounds JSON response buffering before decoding", () =>
  Effect.gen(function* () {
    const http = yield* JsonHttpClient;
    const result = yield* Effect.result(http.request({ ...okRequest, maxResponseBytes: 4 }));
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") expect(result.failure.operation).toBe("response");
  }).pipe(json('{"ok":true}')),
);

it.effect("rejects streaming request bodies that fail schema encoding before transport", () =>
  Effect.gen(function* () {
    const counting = countingClient();
    const FiniteBody = Schema.Struct({ value: Schema.Number.check(Schema.isFinite()) });
    const result = yield* StreamingHttpClient.use((http) =>
      Effect.result(
        http.requestJsonRawBytes({ url: "https://example.invalid", method: "POST" }, FiniteBody, {
          value: Number.NaN,
        }),
      ),
    ).pipe(streaming(counting.client));
    expect(result._tag).toBe("Failure");
    expect(counting.executions()).toBe(0);
  }),
);

it.effect("rejects undefined JSON encodings before production or test transport", () =>
  Effect.gen(function* () {
    // SAFETY: This deliberately invalid codec exercises rejection of a non-JSON encoded value.
    const undefinedAsJson = Schema.Undefined as typeof Schema.Undefined &
      Schema.ConstraintCodec<undefined, Schema.Json, never, never>;
    const request = StreamingHttpClient.use((http) =>
      Effect.result(
        http.requestJsonRawBytes<undefined, Schema.Json, never>(
          { url: "https://example.invalid", method: "POST" },
          undefinedAsJson,
          undefined,
        ),
      ),
    );
    const production = countingClient();
    const productionResult = yield* request.pipe(streaming(production.client));

    let testExecutions = 0;
    const testResult = yield* request.pipe(
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
    expect(production.executions()).toBe(0);
    expect(testExecutions).toBe(0);
  }),
);

it.effect("streams and discards response bodies", () =>
  Effect.gen(function* () {
    const response = yield* streamRequest();
    const text = yield* response.rawBody.pipe(
      Stream.decodeText,
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );
    expect(text).toBe("stream");
    const second = yield* streamRequest();
    yield* second.discardRawBody;
  }).pipe(streaming("stream")),
);

it.effect("maps a mid-stream failure without exposing its cause", () =>
  Effect.gen(function* () {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
        controller.error(new Error("secret stream failure"));
      },
    });
    const result = yield* streamRequest().pipe(
      Effect.flatMap((response) => Effect.result(response.rawBody.pipe(Stream.runDrain))),
      streaming(source),
    );
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
    yield* Effect.gen(function* () {
      const response = yield* streamRequest();
      const consumer = yield* response.rawBody.pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);
    }).pipe(streaming(source), Effect.scoped);
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
    const fiber = yield* JsonHttpClient.use((http) => http.request(okRequest)).pipe(
      json(client),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(finalized).toBe(1);
  }).pipe(Effect.scoped),
);
