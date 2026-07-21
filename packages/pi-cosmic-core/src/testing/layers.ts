import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import {
  JsonDocumentStore,
  type JsonDocumentStoreShape,
  type JsonObject,
} from "../platform/json-document.ts";
import {
  JsonHttpClient,
  type JsonHttpClientShape,
  type JsonHttpRequest,
  type JsonHttpRequestInput,
} from "../platform/json-http.ts";
import { JsonHttpError, StreamingHttpError } from "../platform/errors.ts";
import {
  encodeStreamingJsonBody,
  StreamingHttpClient,
  type StreamingHttpClientShape,
  type StreamingHttpRequest,
  type StreamingHttpResponse,
} from "../platform/streaming-http.ts";

export interface InMemoryDocuments {
  readonly documents: Map<string, JsonObject>;
  readonly service: JsonDocumentStoreShape;
  readonly layer: Layer.Layer<JsonDocumentStore>;
}

export function makeInMemoryDocuments(
  initial: Readonly<Record<string, JsonObject>> = {},
): InMemoryDocuments {
  const documents = new Map(
    Object.entries(initial).map(([path, document]) => [path, { ...document }]),
  );
  const service: JsonDocumentStoreShape = {
    exists: (path) => Effect.succeed(documents.has(path)),
    readObject: (path) =>
      Effect.sync(() => {
        const value = documents.get(path);
        return value ? { ...value } : undefined;
      }),
    writeObject: (path, document) =>
      Effect.sync(() => {
        documents.set(path, { ...document });
      }),
    updateObject: (path, update) =>
      Effect.sync(() => {
        const next = update({ ...documents.get(path) });
        documents.set(path, { ...next });
        return { ...next };
      }),
  };
  return {
    documents,
    service,
    layer: Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service)),
  };
}

type JsonValue = Schema.Schema.Type<typeof Schema.Json>;

export type JsonHttpTestResponse =
  | {
      readonly status: number;
      readonly body: JsonValue;
      readonly rawBody?: never;
    }
  | {
      readonly status: number;
      readonly rawBody: string;
      readonly body?: never;
    };

export type JsonHttpTestRequest = Omit<
  JsonHttpRequest<Schema.ConstraintDecoder<unknown, unknown>>,
  "responseSchema"
> & { readonly responseSchema: Schema.Constraint };

export const jsonHttpTestLayer = (
  handle: (input: JsonHttpTestRequest) => Effect.Effect<JsonHttpTestResponse, JsonHttpError>,
): Layer.Layer<JsonHttpClient> => {
  const request: JsonHttpClientShape["request"] = <A, R>(input: JsonHttpRequestInput<A, R>) =>
    Effect.gen(function* () {
      const response = yield* handle(input as JsonHttpTestRequest);
      const accepted = (input.acceptStatus ?? ((status) => status >= 200 && status < 300))(
        response.status,
      );
      if (!accepted) {
        const errorBody =
          "rawBody" in response
            ? response.rawBody
            : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(response.body).pipe(
                Effect.mapError(
                  () =>
                    new JsonHttpError({
                      operation: "response",
                      message: "Unable to read HTTP response.",
                    }),
                ),
              );
        return {
          _tag: "Rejected",
          status: response.status,
          errorBody,
        } as const;
      }
      const rawBody =
        "body" in response
          ? response.body
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
              response.rawBody,
            ).pipe(
              Effect.mapError(
                () =>
                  new JsonHttpError({
                    operation: "response",
                    message: "Unable to read HTTP response.",
                  }),
              ),
            );
      const body = yield* Schema.decodeUnknownEffect(input.responseSchema)(rawBody).pipe(
        Effect.mapError(
          () =>
            new JsonHttpError({
              operation: "decode",
              message: "HTTP response did not match the expected schema.",
            }),
        ),
      );
      return { _tag: "Accepted", status: response.status, body } as const;
    });
  return Layer.succeed(JsonHttpClient, JsonHttpClient.of({ request }));
};

export interface StreamingHttpTestRequest extends StreamingHttpRequest {
  readonly encodedJsonBody?: JsonValue;
}

export const streamingHttpTestLayer = (
  handle: (
    input: StreamingHttpTestRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>,
): Layer.Layer<StreamingHttpClient> => {
  const requestRawBytes: StreamingHttpClientShape["requestRawBytes"] = handle;
  const requestJsonRawBytes: StreamingHttpClientShape["requestJsonRawBytes"] = (
    input,
    bodySchema,
    body,
  ) =>
    encodeStreamingJsonBody(bodySchema, body).pipe(
      Effect.flatMap((encodedJsonBody) => handle({ ...input, encodedJsonBody })),
    );
  return Layer.succeed(
    StreamingHttpClient,
    StreamingHttpClient.of({ requestRawBytes, requestJsonRawBytes }),
  );
};

export const jsonHttpResponse = (status: number, body: JsonValue): JsonHttpTestResponse => ({
  status,
  body,
});

export const jsonHttpRawResponse = (status: number, rawBody: string): JsonHttpTestResponse => ({
  status,
  rawBody,
});

export const streamingHttpResponse = (
  status: number,
  rawBody: StreamingHttpResponse["rawBody"],
): StreamingHttpResponse => ({
  status,
  rawBody,
  discardRawBody: rawBody.pipe(Stream.runDrain),
});

export interface LifecycleProbe {
  readonly events: readonly string[];
  readonly acquired: () => number;
  readonly released: () => number;
  readonly layer: Layer.Layer<never>;
}

/** Counts acquisition/finalization without exposing a Ref or requiring a test framework. */
export function makeLifecycleProbe(
  acquiredEvent = "acquired",
  releasedEvent = "released",
): LifecycleProbe {
  const events: string[] = [];
  let acquiredCount = 0;
  let releasedCount = 0;
  const layer = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        acquiredCount++;
        events.push(acquiredEvent);
      }),
      () =>
        Effect.sync(() => {
          releasedCount++;
          events.push(releasedEvent);
        }),
    ),
  );
  return {
    events,
    acquired: () => acquiredCount,
    released: () => releasedCount,
    layer,
  };
}

export interface CapturedLogger {
  readonly entries: unknown[];
  readonly layer: Layer.Layer<never>;
}

export function makeCapturedLogger(): CapturedLogger {
  const entries: unknown[] = [];
  const logger = Logger.make<unknown, void>(({ message }) => {
    entries.push(message);
  });
  return { entries, layer: Logger.layer([logger]) };
}

export interface CapturedTracer {
  readonly spans: Tracer.NativeSpan[];
  readonly layer: Layer.Layer<never>;
}

export function makeCapturedTracer(): CapturedTracer {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, layer: Layer.succeed(Tracer.Tracer, tracer) };
}

/** Stable serialization for secret-absence assertions; excludes timing and runtime span objects. */
export const capturedTelemetrySnapshot = (capture: {
  readonly entries?: readonly unknown[];
  readonly spans?: readonly Tracer.NativeSpan[];
}): string =>
  JSON.stringify({
    entries: capture.entries ?? [],
    spans: (capture.spans ?? []).map((span) => ({
      name: span.name,
      attributes: [...span.attributes],
    })),
  });
