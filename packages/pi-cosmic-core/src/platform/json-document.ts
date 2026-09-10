import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { JsonDocumentError } from "./errors.ts";
import { ProcessCoordinator } from "./process-coordinator.ts";

/** Mutable JSON value accepted by the document store. */
export type JsonValue = Schema.MutableJson;

/** Schema-backed mutable JSON object persisted by the document store. */
export type JsonObject = Schema.MutableJsonObject;

export const isJsonObject = <Value>(value: Value): value is Value & JsonObject =>
  Schema.is(Schema.MutableJson)(value) && Predicate.isObject(value);

export interface JsonDocumentModification<A, AfterCommitR = never> {
  readonly value: A;
  readonly document: JsonObject;
  /** False returns from the locked transaction without writing or running `afterCommit`. */
  readonly write?: boolean | undefined;
  /** Runs exactly once after the document rename, inside the same uninterruptible commit region. */
  readonly afterCommit?: Effect.Effect<void, never, AfterCommitR>;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
export const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema, { space: 2 });

/** Raw UTF-8 read limit. Mutations also bound the serialized replacement before committing. */
export interface JsonDocumentReadOptions {
  /** Positive integer, at most 64 MiB. */
  readonly maxBytes?: number | undefined;
}

const ReadOptionsSchema = Schema.Struct({
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 })),
  ),
});
const readLimitError = (path: string) =>
  new JsonDocumentError({ operation: "read", path, message: "JSON document exceeds read limits." });

/** Shared with the in-memory store so option validation also applies to missing documents. */
export const validateJsonDocumentReadOptions = (path: string, options?: JsonDocumentReadOptions) =>
  options === undefined
    ? Effect.succeed(undefined)
    : Schema.decodeUnknownEffect(ReadOptionsSchema)(options).pipe(
        Effect.mapError(
          () =>
            new JsonDocumentError({
              operation: "read",
              path,
              message: "Invalid JSON document read limits.",
            }),
        ),
      );

export interface JsonDocumentStoreContract {
  readonly exists: (path: string) => Effect.Effect<boolean, JsonDocumentError>;
  readonly readObject: (
    path: string,
    options?: JsonDocumentReadOptions,
  ) => Effect.Effect<JsonObject | undefined, JsonDocumentError>;
  readonly writeObject: (
    path: string,
    document: JsonObject,
  ) => Effect.Effect<void, JsonDocumentError>;
  /** Optional additive capability for effectful mutation under the process lock. */
  readonly modifyObject?: <A, E, R, AfterCommitR = never>(
    path: string,
    modify: (
      document: JsonObject,
    ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
    options?: JsonDocumentReadOptions,
  ) => Effect.Effect<A, JsonDocumentError | E, R | AfterCommitR>;
  readonly updateObject: (
    path: string,
    update: (document: JsonObject) => JsonObject,
    options?: JsonDocumentReadOptions,
  ) => Effect.Effect<JsonObject, JsonDocumentError>;
}

/** A document store that guarantees effectful read-modify-write transactions. */
export interface AtomicJsonDocumentStoreContract extends JsonDocumentStoreContract {
  readonly modifyObject: <A, E, R, AfterCommitR = never>(
    path: string,
    modify: (
      document: JsonObject,
    ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
    options?: JsonDocumentReadOptions,
  ) => Effect.Effect<A, JsonDocumentError | E, R | AfterCommitR>;
}

export class JsonDocumentStore extends Context.Service<
  JsonDocumentStore,
  JsonDocumentStoreContract
>()("pi-cosmic-core/platform/json-document/JsonDocumentStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const coordinator = yield* ProcessCoordinator;

      const mapError = (operation: string, path: string, message: string) => () =>
        new JsonDocumentError({ operation, path, message });

      const exists = Effect.fn("JsonDocumentStore.exists")((path: string) =>
        fs
          .exists(path)
          .pipe(Effect.mapError(mapError("exists", path, "Unable to inspect JSON document path."))),
      );

      const readObjectUnlocked = Effect.fn("JsonDocumentStore.readObjectUnlocked")(function* (
        path: string,
        options?: JsonDocumentReadOptions,
      ) {
        const limits = yield* validateJsonDocumentReadOptions(path, options);
        const maxBytes = limits?.maxBytes;
        const readSource =
          maxBytes === undefined
            ? fs.readFileString(path)
            : fs
                .stream(path, {
                  bytesToRead: maxBytes + 1,
                  chunkSize: Math.min(64 * 1024, maxBytes + 1),
                })
                .pipe(
                  Stream.runCollect,
                  Effect.flatMap((chunks) => {
                    if (chunks.reduce((total, chunk) => total + chunk.byteLength, 0) > maxBytes)
                      return Effect.fail(readLimitError(path));
                    const decoder = new TextDecoder();
                    return Effect.succeed(
                      chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") +
                        decoder.decode(),
                    );
                  }),
                );
        const source = yield* readSource.pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error._tag === "JsonDocumentError"
              ? Effect.fail(error)
              : error.reason._tag === "NotFound"
                ? Effect.succeedNone
                : Effect.fail(mapError("read", path, "Unable to read JSON document.")()),
          ),
        );
        if (Option.isNone(source)) return undefined;
        return yield* Schema.decodeUnknownEffect(JsonObjectFromString)(source.value).pipe(
          Effect.mapError(mapError("decode", path, "JSON document must contain an object.")),
        );
      });

      const readObject = Effect.fn("JsonDocumentStore.readObject")(
        (path: string, options?: JsonDocumentReadOptions) => readObjectUnlocked(path, options),
      );

      const encodeObject = (path: string, document: JsonObject) =>
        Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
          Effect.mapError(mapError("encode", path, "Unable to encode JSON document.")),
        );

      const writeObjectUnlocked = Effect.fn("JsonDocumentStore.writeObjectUnlocked")(function* <
        AfterCommitR,
      >(
        path: string,
        document: JsonObject,
        afterCommit?: Effect.Effect<void, never, AfterCommitR>,
        options?: JsonDocumentReadOptions,
      ) {
        const source = yield* encodeObject(path, document);
        if (
          options?.maxBytes !== undefined &&
          new TextEncoder().encode(`${source}\n`).byteLength > options.maxBytes
        )
          return yield* new JsonDocumentError({
            operation: "write",
            path,
            message: "JSON document replacement exceeds its byte limit.",
          });
        const directory = pathService.dirname(path);
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(
            Effect.mapError(mapError("mkdir", path, "Unable to create JSON document directory.")),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporaryPath = yield* Effect.acquireRelease(
              fs
                .makeTempFile({
                  directory,
                  prefix: `.${pathService.basename(path)}.`,
                  suffix: ".tmp",
                })
                .pipe(
                  Effect.mapError(
                    mapError("write", path, "Unable to create temporary JSON document."),
                  ),
                ),
              (ownedPath) =>
                fs
                  .remove(pathService.dirname(ownedPath), { recursive: true })
                  .pipe(Effect.ignoreCause),
            );
            yield* fs
              .writeFileString(temporaryPath, `${source}\n`, { mode: 0o600 })
              .pipe(
                Effect.mapError(
                  mapError("write", path, "Unable to write temporary JSON document."),
                ),
              );
            yield* fs
              .chmod(temporaryPath, 0o600)
              .pipe(
                Effect.mapError(
                  mapError("chmod", path, "Unable to protect temporary JSON document."),
                ),
              );
            yield* fs
              .rename(temporaryPath, path)
              .pipe(
                Effect.andThen(afterCommit ?? Effect.void),
                Effect.mapError(
                  mapError("rename", path, "Unable to replace JSON document atomically."),
                ),
                Effect.uninterruptible,
              );
          }),
        );
      });

      const writeObject = Effect.fn("JsonDocumentStore.writeObject")(
        (path: string, document: JsonObject) =>
          coordinator.withLock(
            pathService.resolve(path),
            writeObjectUnlocked(path, document, Effect.void),
          ),
      );

      const modifyObject: AtomicJsonDocumentStoreContract["modifyObject"] = Effect.fn(
        "JsonDocumentStore.modifyObject",
      )(function* <A, E, R, AfterCommitR = never>(
        path: string,
        modify: (
          document: JsonObject,
        ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
        options?: JsonDocumentReadOptions,
      ) {
        return yield* coordinator.withLock(
          pathService.resolve(path),
          Effect.gen(function* () {
            const current = (yield* readObjectUnlocked(path, options)) ?? {};
            const modification = yield* modify(current);
            if (modification.write !== false)
              yield* writeObjectUnlocked(
                path,
                modification.document,
                modification.afterCommit,
                options,
              );
            return modification.value;
          }),
        );
      });

      const updateObject: JsonDocumentStoreContract["updateObject"] = Effect.fn(
        "JsonDocumentStore.updateObject",
      )((path, update, options) =>
        modifyObject(
          path,
          (current) =>
            Effect.try({
              try: () => {
                const next = update(current);
                return {
                  value: next,
                  document: next,
                } satisfies JsonDocumentModification<JsonObject>;
              },
              catch: mapError("update", path, "Unable to update JSON document."),
            }),
          options,
        ),
      );

      return JsonDocumentStore.of({ exists, readObject, writeObject, modifyObject, updateObject });
    }),
  );
}
