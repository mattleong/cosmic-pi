import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import {
  JsonDocumentStore,
  JsonObjectFromString,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "../platform/json-document.ts";
import { JsonDocumentError, type StreamingHttpError } from "../platform/errors.ts";
import {
  StreamingHttpClient,
  type StreamingHttpRequest,
  type StreamingHttpResponse,
  withStreamingJsonBody,
} from "../platform/streaming-http.ts";

interface InMemoryDocumentMap {
  readonly get: (path: string) => JsonObject | undefined;
  readonly set: (path: string, document: JsonObject) => void;
  readonly values: () => IterableIterator<JsonObject>;
}

export interface InMemoryDocuments {
  readonly documents: InMemoryDocumentMap;
  readonly service: JsonDocumentStoreContract;
  readonly layer: Layer.Layer<JsonDocumentStore>;
  readonly operations: readonly string[];
  readonly injectBeforeNextUpdate: (update: (current: JsonObject) => JsonObject) => void;
  readonly blockNextUpdateBeforeCommit: (
    started: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>,
  ) => void;
  readonly blockNextUpdateAtCommit: (
    started: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>,
  ) => void;
}

interface JsonDocumentUpdateGate {
  readonly phase: "BeforeCommit" | "Committed";
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const cloneInitialDocument = (document: JsonObject): JsonObject => {
  const source = Schema.encodeUnknownSync(JsonObjectFromString)(document);
  return Schema.decodeSync(JsonObjectFromString)(source);
};

const documentView = (stored: Map<string, JsonObject>): InMemoryDocumentMap => ({
  get: (path) => {
    const document = stored.get(path);
    return document === undefined ? undefined : cloneInitialDocument(document);
  },
  set: (path, document) => void stored.set(path, cloneInitialDocument(document)),
  values: () => Array.from(stored.values(), cloneInitialDocument).values(),
});

const cloneDocument = (operation: string, path: string, document: JsonObject) =>
  Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
    Effect.flatMap((source) => Schema.decodeEffect(JsonObjectFromString)(source)),
    Effect.mapError(() =>
      JsonDocumentError.make({ operation, path, message: "Unable to clone JSON document." }),
    ),
  );

export function makeInMemoryDocuments(
  initial: Readonly<Record<string, JsonObject>> = {},
): InMemoryDocuments {
  const storedDocuments = new Map(
    Arr.map(Rec.toEntries(initial), ([path, document]) => [path, cloneInitialDocument(document)]),
  );
  const documents = documentView(storedDocuments);
  const pathSemaphores = new Map<string, Semaphore.Semaphore>();
  let beforeNextUpdate: ((current: JsonObject) => JsonObject) | undefined;
  let nextUpdateGate: JsonDocumentUpdateGate | undefined;
  const operations: string[] = [];
  const record = (operation: string, path: string) =>
    Effect.sync(() => void operations.push(`${operation}:${path}`));
  const semaphoreFor = (path: string): Semaphore.Semaphore => {
    const existing = pathSemaphores.get(path);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    pathSemaphores.set(path, created);
    return created;
  };
  const modifyObject: JsonDocumentStoreContract["modifyObject"] = (path, modify) =>
    semaphoreFor(path).withPermit(
      Effect.gen(function* () {
        const current = storedDocuments.get(path);
        const isolated: JsonObject =
          current === undefined ? {} : yield* cloneDocument("read", path, current);
        const injected = beforeNextUpdate;
        beforeNextUpdate = undefined;
        const atomicCurrent = injected ? injected(isolated) : isolated;
        const { value, document, write, afterCommit } = yield* modify(atomicCurrent);
        if (write === false) return value;
        const stored = yield* cloneDocument("update", path, document);
        const gate = nextUpdateGate;
        nextUpdateGate = undefined;
        if (gate?.phase === "BeforeCommit") {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => void storedDocuments.set(path, stored));
          if (gate?.phase === "Committed") {
            yield* Deferred.succeed(gate.started, undefined);
            yield* Deferred.await(gate.release);
          }
          yield* afterCommit ?? Effect.void;
        }).pipe(Effect.uninterruptible);
        return value;
      }),
    );
  const service: JsonDocumentStoreContract = {
    exists: (path) =>
      record("exists", path).pipe(Effect.andThen(Effect.sync(() => storedDocuments.has(path)))),
    readObject: Effect.fnUntraced(function* (path) {
      yield* record("read", path);
      const value = storedDocuments.get(path);
      if (value === undefined) return undefined;
      return yield* cloneDocument("read", path, value);
    }),
    writeObject: (path, document) =>
      record("write", path).pipe(
        Effect.andThen(
          semaphoreFor(path).withPermit(
            cloneDocument("write", path, document).pipe(
              Effect.map((stored) => void storedDocuments.set(path, stored)),
            ),
          ),
        ),
      ),
    modifyObject: (path, modify) =>
      record("modify", path).pipe(Effect.andThen(modifyObject(path, modify))),
  };
  return {
    documents,
    service,
    operations,
    layer: Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service)),
    injectBeforeNextUpdate(update) {
      beforeNextUpdate = update;
    },
    blockNextUpdateBeforeCommit(started, release) {
      nextUpdateGate = { phase: "BeforeCommit", started, release };
    },
    blockNextUpdateAtCommit(started, release) {
      nextUpdateGate = { phase: "Committed", started, release };
    },
  };
}

export interface StreamingHttpTestRequest extends StreamingHttpRequest {
  readonly encodedJsonBody?: Schema.Json;
}

export const streamingHttpTestLayer = (
  handle: (
    input: StreamingHttpTestRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>,
): Layer.Layer<StreamingHttpClient> => {
  const requestJsonRawBytes = withStreamingJsonBody((input, encodedJsonBody) =>
    handle({ ...input, encodedJsonBody }),
  );
  return Layer.succeed(StreamingHttpClient, StreamingHttpClient.of({ requestJsonRawBytes }));
};

export const streamingHttpResponse = (
  status: number,
  rawBody: StreamingHttpResponse["rawBody"],
): StreamingHttpResponse => ({
  status,
  rawBody,
  discardRawBody: rawBody.pipe(Stream.runDrain),
});

interface LifecycleProbe {
  readonly events: readonly string[];
  readonly acquired: () => number;
  readonly released: () => number;
  readonly layer: Layer.Layer<never>;
}

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

interface CapturedLogger {
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

interface CapturedTracer {
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

export const capturedTelemetrySnapshot = (capture: {
  readonly entries?: readonly unknown[];
  readonly spans?: readonly Tracer.NativeSpan[];
}): string =>
  JSON.stringify({
    entries: capture.entries ?? [],
    spans: Arr.map(capture.spans ?? [], (span) => ({
      name: span.name,
      attributes: [...span.attributes],
    })),
  });
