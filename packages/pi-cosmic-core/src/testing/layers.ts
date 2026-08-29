import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import {
  type AtomicJsonDocumentStoreContract,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "../platform/json-document.ts";
import {
  JsonHttpClient,
  type JsonHttpClientContract,
  type JsonHttpRequest,
  type JsonHttpRequestInput,
} from "../platform/json-http.ts";
import { JsonDocumentError, JsonHttpError, StreamingHttpError } from "../platform/errors.ts";
import { encodeJsonBody } from "../platform/json-body.ts";
import {
  encodeStreamingJsonBody,
  StreamingHttpClient,
  type StreamingHttpClientContract,
  type StreamingHttpRequest,
  type StreamingHttpResponse,
} from "../platform/streaming-http.ts";

export interface InMemoryDocuments {
  /** Mutable compatibility handle for simulating external document changes in tests. */
  readonly documents: Map<string, JsonObject>;
  readonly service: AtomicJsonDocumentStoreContract;
  readonly layer: Layer.Layer<JsonDocumentStore>;
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

const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema);

const cloneInitialDocument = (document: JsonObject): JsonObject => {
  const source = Schema.encodeUnknownSync(JsonObjectFromString)(document);
  return Schema.decodeUnknownSync(JsonObjectFromString)(source);
};

class JsonDocumentMapView implements Map<string, JsonObject> {
  readonly [Symbol.toStringTag] = "Map";
  private readonly stored: Map<string, JsonObject>;

  constructor(stored: Map<string, JsonObject>) {
    this.stored = stored;
  }

  private snapshot(): Map<string, JsonObject> {
    return new Map(
      Array.from(this.stored, ([path, document]) => [path, cloneInitialDocument(document)]),
    );
  }

  get size(): number {
    return this.stored.size;
  }

  get(path: string): JsonObject | undefined {
    const document = this.stored.get(path);
    return document === undefined ? undefined : cloneInitialDocument(document);
  }

  has(path: string): boolean {
    return this.stored.has(path);
  }

  set(path: string, document: JsonObject): this {
    this.stored.set(path, cloneInitialDocument(document));
    return this;
  }

  delete(path: string): boolean {
    return this.stored.delete(path);
  }

  clear(): void {
    this.stored.clear();
  }

  entries(): MapIterator<[string, JsonObject]> {
    return this.snapshot().entries();
  }

  keys(): MapIterator<string> {
    return this.stored.keys();
  }

  values(): MapIterator<JsonObject> {
    return this.snapshot().values();
  }

  forEach<ThisArgInput>(
    callback: (value: JsonObject, key: string, map: Map<string, JsonObject>) => void,
    thisArg?: ThisArgInput,
  ): void {
    for (const [path, document] of this.entries()) callback.call(thisArg, document, path, this);
  }

  [Symbol.iterator](): MapIterator<[string, JsonObject]> {
    return this.entries();
  }
}

const cloneDocument = (operation: string, path: string, document: JsonObject) =>
  Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
    Effect.flatMap((source) => Schema.decodeUnknownEffect(JsonObjectFromString)(source)),
    Effect.mapError(
      () =>
        new JsonDocumentError({
          operation,
          path,
          message: "Unable to clone JSON document.",
        }),
    ),
  );

export function makeInMemoryDocuments(
  initial: Readonly<Record<string, JsonObject>> = {},
): InMemoryDocuments {
  const storedDocuments = new Map(
    Object.entries(initial).map(([path, document]) => [path, cloneInitialDocument(document)]),
  );
  const documents = new JsonDocumentMapView(storedDocuments);
  const pathSemaphores = new Map<string, Semaphore.Semaphore>();
  let beforeNextUpdate: ((current: JsonObject) => JsonObject) | undefined;
  let nextUpdateGate: JsonDocumentUpdateGate | undefined;
  let updateCount = 0;
  const semaphoreFor = (path: string): Semaphore.Semaphore => {
    const existing = pathSemaphores.get(path);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    pathSemaphores.set(path, created);
    return created;
  };
  const modifyObject: AtomicJsonDocumentStoreContract["modifyObject"] = (path, modify) =>
    semaphoreFor(path).withPermit(
      Effect.gen(function* () {
        updateCount++;
        const current = storedDocuments.get(path);
        // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
        const isolated =
          current === undefined ? ({} as JsonObject) : yield* cloneDocument("read", path, current);
        const atomicCurrent = beforeNextUpdate ? beforeNextUpdate(isolated) : isolated;
        beforeNextUpdate = undefined;
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
  const updateObject: JsonDocumentStoreContract["updateObject"] = (path, update) =>
    modifyObject(path, (document) =>
      Effect.try({
        try: () => {
          const next = update(document);
          return {
            value: next,
            document: next,
          } satisfies JsonDocumentModification<JsonObject>;
        },
        catch: () =>
          new JsonDocumentError({
            operation: "update",
            path,
            message: "Unable to update JSON document.",
          }),
      }),
    );
  const service: AtomicJsonDocumentStoreContract = {
    exists: (path) => Effect.succeed(storedDocuments.has(path)),
    readObject: (path) =>
      Effect.gen(function* () {
        const value = storedDocuments.get(path);
        if (value === undefined) return undefined;
        return yield* cloneDocument("read", path, value);
      }),
    writeObject: (path, document) =>
      semaphoreFor(path).withPermit(
        cloneDocument("write", path, document).pipe(
          Effect.map((stored) => void storedDocuments.set(path, stored)),
        ),
      ),
    modifyObject,
    updateObject,
  };
  return {
    documents,
    service,
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
> & {
  readonly responseSchema: Schema.Constraint;
  readonly encodedJsonBody?: JsonValue;
};

const jsonHttpError = (operation: JsonHttpError["operation"], message: string) => () =>
  new JsonHttpError({ operation, message });

export const jsonHttpTestLayer = (
  handle: (input: JsonHttpTestRequest) => Effect.Effect<JsonHttpTestResponse, JsonHttpError>,
): Layer.Layer<JsonHttpClient> => {
  const execute = <A, R>(input: JsonHttpRequestInput<A, R>, encodedJsonBody?: JsonValue) =>
    Effect.gen(function* () {
      const requestInput = encodedJsonBody === undefined ? input : { ...input, encodedJsonBody };
      // SAFETY: The typed owner constructs the request on this test-only boundary.
      const response = yield* handle(requestInput as JsonHttpTestRequest);
      const accepted = (input.acceptStatus ?? ((status) => status >= 200 && status < 300))(
        response.status,
      );
      if (!accepted) {
        const errorBody =
          "rawBody" in response
            ? response.rawBody
            : yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json))(response.body).pipe(
                Effect.mapError(jsonHttpError("response", "Unable to read HTTP response.")),
              );
        return { _tag: "Rejected", status: response.status, errorBody } as const;
      }
      const rawBody =
        "body" in response
          ? response.body
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(
              response.rawBody,
            ).pipe(Effect.mapError(jsonHttpError("response", "Unable to read HTTP response.")));
      const body = yield* Schema.decodeUnknownEffect(input.responseSchema)(rawBody).pipe(
        Effect.mapError(
          jsonHttpError("decode", "HTTP response did not match the expected schema."),
        ),
      );
      return { _tag: "Accepted", status: response.status, body } as const;
    });
  const request: JsonHttpClientContract["request"] = (input) => execute(input);
  const requestJson: JsonHttpClientContract["requestJson"] = (input, bodySchema, body) =>
    encodeJsonBody(bodySchema, body).pipe(
      Effect.mapError(
        jsonHttpError("encode", "HTTP request body did not match the expected schema."),
      ),
      Effect.flatMap((encodedJsonBody) => execute(input, encodedJsonBody)),
    );
  return Layer.succeed(JsonHttpClient, JsonHttpClient.of({ request, requestJson }));
};

export interface StreamingHttpTestRequest extends StreamingHttpRequest {
  readonly encodedJsonBody?: JsonValue;
}

export const streamingHttpTestLayer = (
  handle: (
    input: StreamingHttpTestRequest,
  ) => Effect.Effect<StreamingHttpResponse, StreamingHttpError>,
): Layer.Layer<StreamingHttpClient> => {
  const requestRawBytes: StreamingHttpClientContract["requestRawBytes"] = handle;
  const requestJsonRawBytes: StreamingHttpClientContract["requestJsonRawBytes"] = (
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
