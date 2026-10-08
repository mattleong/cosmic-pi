import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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
import {
  JsonHttpClient,
  makeJsonHttpClient,
  responseDecodeError,
  type JsonHttpRequest,
} from "../platform/json-http.ts";
import { JsonDocumentError, JsonHttpError, StreamingHttpError } from "../platform/errors.ts";
import {
  StreamingHttpClient,
  type StreamingHttpRequest,
  type StreamingHttpResponse,
  withStreamingJsonBody,
} from "../platform/streaming-http.ts";

/** Clone-on-read, clone-on-write view of the stored documents. */
interface InMemoryDocumentMap {
  readonly size: number;
  readonly get: (path: string) => JsonObject | undefined;
  readonly has: (path: string) => boolean;
  readonly set: (path: string, document: JsonObject) => void;
  readonly values: () => IterableIterator<JsonObject>;
}

export interface InMemoryDocuments {
  /** Mutable handle for simulating external document changes in tests. */
  readonly documents: InMemoryDocumentMap;
  readonly service: JsonDocumentStoreContract;
  readonly layer: Layer.Layer<JsonDocumentStore>;
  /** `operation:path` for each executed public store call, e.g. to prove absent project I/O. */
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
  readonly updateCount: number;
}

interface JsonDocumentUpdateGate {
  readonly _tag: "BeforeCommit" | "Committed";
  readonly started: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const cloneInitialDocument = (document: JsonObject): JsonObject => {
  const source = Schema.encodeUnknownSync(JsonObjectFromString)(document);
  return Schema.decodeSync(JsonObjectFromString)(source);
};

const documentView = (stored: Map<string, JsonObject>): InMemoryDocumentMap => ({
  get size() {
    return stored.size;
  },
  get: (path) => {
    const document = stored.get(path);
    return document === undefined ? undefined : cloneInitialDocument(document);
  },
  has: (path) => stored.has(path),
  set: (path, document) => void stored.set(path, cloneInitialDocument(document)),
  values: () => Array.from(stored.values(), cloneInitialDocument).values(),
});

// Match the live store's serialized representation.
const cloneDocument = (operation: string, path: string, document: JsonObject) =>
  Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
    Effect.flatMap((source) => Schema.decodeEffect(JsonObjectFromString)(source)),
    Effect.mapError(
      () => new JsonDocumentError({ operation, path, message: "Unable to clone JSON document." }),
    ),
  );

export function makeInMemoryDocuments(
  initial: Readonly<Record<string, JsonObject>> = {},
): InMemoryDocuments {
  const storedDocuments = new Map(
    Object.entries(initial).map(([path, document]) => [path, cloneInitialDocument(document)]),
  );
  const documents = documentView(storedDocuments);
  const pathSemaphores = new Map<string, Semaphore.Semaphore>();
  let beforeNextUpdate: ((current: JsonObject) => JsonObject) | undefined;
  let nextUpdateGate: JsonDocumentUpdateGate | undefined;
  let updateCount = 0;
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
        updateCount++;
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
        if (gate?._tag === "BeforeCommit") {
          yield* Deferred.succeed(gate.started, undefined);
          yield* Deferred.await(gate.release);
        }
        yield* Effect.gen(function* () {
          yield* Effect.sync(() => void storedDocuments.set(path, stored));
          if (gate?._tag === "Committed") {
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
    readObject: (path) =>
      Effect.gen(function* () {
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
      nextUpdateGate = { _tag: "BeforeCommit", started, release };
    },
    blockNextUpdateAtCommit(started, release) {
      nextUpdateGate = { _tag: "Committed", started, release };
    },
    get updateCount() {
      return updateCount;
    },
  };
}

export type JsonHttpTestResponse =
  | {
      readonly status: number;
      readonly body: Schema.Json;
      readonly rawBody?: never;
    }
  | {
      readonly status: number;
      readonly rawBody: string;
      readonly body?: never;
    };

type JsonHttpTestRequest = Omit<
  JsonHttpRequest<Schema.ConstraintDecoder<unknown, unknown>>,
  "responseSchema"
> & {
  readonly responseSchema: Schema.Constraint;
  readonly encodedJsonBody?: Schema.Json;
};

export const jsonHttpTestLayer = (
  handle: (input: JsonHttpTestRequest) => Effect.Effect<JsonHttpTestResponse, JsonHttpError>,
): Layer.Layer<JsonHttpClient> =>
  Layer.succeed(
    JsonHttpClient,
    JsonHttpClient.of(
      makeJsonHttpClient((input, encodedJsonBody) =>
        Effect.gen(function* () {
          const requestInput =
            encodedJsonBody === undefined ? input : { ...input, encodedJsonBody };
          // SAFETY: The typed owner constructs the request on this test-only boundary.
          const response = yield* handle(requestInput as JsonHttpTestRequest);
          if (response.status < 200 || response.status >= 300)
            return { _tag: "Rejected", status: response.status } as const;
          const rawBody =
            "body" in response
              ? response.body
              : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
                  response.rawBody,
                ).pipe(Effect.mapError(responseDecodeError));
          const body = yield* Schema.decodeEffect(input.responseSchema)(rawBody).pipe(
            Effect.mapError(responseDecodeError),
          );
          return { _tag: "Accepted", status: response.status, body } as const;
        }),
      ),
    ),
  );

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

interface LifecycleProbe {
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
