import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
  type JsonHttpResponse,
} from "../platform/json-http.ts";
import {
  StreamingHttpClient,
  type StreamingHttpClientShape,
  type StreamingHttpRequest,
  type StreamingHttpResponse,
} from "../platform/streaming-http.ts";

export interface InMemoryDocuments {
  readonly documents: Map<string, JsonObject>;
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
    layer: Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service)),
  };
}

export const jsonHttpTestLayer = (
  request: (input: JsonHttpRequest) => ReturnType<JsonHttpClientShape["request"]>,
): Layer.Layer<JsonHttpClient> => Layer.succeed(JsonHttpClient, JsonHttpClient.of({ request }));

export const streamingHttpTestLayer = (
  request: (input: StreamingHttpRequest) => ReturnType<StreamingHttpClientShape["request"]>,
): Layer.Layer<StreamingHttpClient> =>
  Layer.succeed(StreamingHttpClient, StreamingHttpClient.of({ request }));

export const jsonHttpResponse = (status: number, body: unknown): JsonHttpResponse => ({
  status,
  body,
});

export const streamingHttpResponse = (
  status: number,
  body: StreamingHttpResponse["body"],
): StreamingHttpResponse => ({
  status,
  body,
  discard: body.pipe(Stream.runDrain),
});

export function acquisitionProbe(
  events: string[],
  acquired = "acquired",
  released = "released",
): Layer.Layer<never> {
  return Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => {
        events.push(acquired);
      }),
      () =>
        Effect.sync(() => {
          events.push(released);
        }),
    ),
  );
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
