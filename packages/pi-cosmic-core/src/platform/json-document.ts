import { hasObjectRuntimeType } from "../runtime-values.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { JsonDocumentError } from "./errors.ts";
import { ProcessCoordinator } from "./process-coordinator.ts";

/** Mutable JSON value accepted by the document store. */
export type JsonValue = Schema.MutableJson;

/** Schema-backed mutable JSON object persisted by the document store. */
export type JsonObject = Schema.MutableJsonObject;

export const isJsonObject = <Value>(value: Value): value is Value & JsonObject =>
  Schema.is(Schema.MutableJson)(value) &&
  hasObjectRuntimeType(value) &&
  value !== null &&
  !Array.isArray(value);

export interface JsonDocumentModification<A, AfterCommitR = never> {
  readonly value: A;
  readonly document: JsonObject;
  /** False returns from the locked transaction without writing or running `afterCommit`. */
  readonly write?: boolean | undefined;
  /** Runs exactly once after the document rename, inside the same uninterruptible commit region. */
  readonly afterCommit?: Effect.Effect<void, never, AfterCommitR>;
}

const UnknownFromPrettyJsonString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    new SchemaTransformation.Transformation<unknown, string>(
      SchemaGetter.parseJson(),
      SchemaGetter.stringifyJson({ space: 2 }),
    ),
  ),
);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
const JsonObjectFromString = UnknownFromPrettyJsonString.pipe(Schema.decodeTo(JsonObjectSchema));

export interface JsonDocumentStoreContract {
  readonly exists: (path: string) => Effect.Effect<boolean, JsonDocumentError>;
  readonly readObject: (path: string) => Effect.Effect<JsonObject | undefined, JsonDocumentError>;
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
  ) => Effect.Effect<A, JsonDocumentError | E, R | AfterCommitR>;
  readonly updateObject: (
    path: string,
    update: (document: JsonObject) => JsonObject,
  ) => Effect.Effect<JsonObject, JsonDocumentError>;
}

/** A document store that guarantees effectful read-modify-write transactions. */
export interface AtomicJsonDocumentStoreContract extends JsonDocumentStoreContract {
  readonly modifyObject: <A, E, R, AfterCommitR = never>(
    path: string,
    modify: (
      document: JsonObject,
    ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
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

      const exists = Effect.fn("JsonDocumentStore.exists")(function* (path: string) {
        return yield* fs
          .exists(path)
          .pipe(Effect.mapError(mapError("exists", path, "Unable to inspect JSON document path.")));
      });

      const readObjectUnlocked = Effect.fn("JsonDocumentStore.readObjectUnlocked")(function* (
        path: string,
      ) {
        const source = yield* fs.readFileString(path).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            error.reason._tag === "NotFound"
              ? Effect.succeedNone
              : Effect.fail(mapError("read", path, "Unable to read JSON document.")()),
          ),
        );
        if (Option.isNone(source)) return undefined;
        return yield* Schema.decodeUnknownEffect(JsonObjectFromString)(source.value).pipe(
          Effect.mapError(mapError("decode", path, "JSON document must contain an object.")),
        );
      });

      const readObject = Effect.fn("JsonDocumentStore.readObject")((path: string) =>
        readObjectUnlocked(path),
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
      ) {
        const source = yield* encodeObject(path, document);
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
                  .pipe(Effect.catchCause(() => Effect.void)),
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
      ) {
        return yield* coordinator.withLock(
          pathService.resolve(path),
          Effect.gen(function* () {
            const current = (yield* readObjectUnlocked(path)) ?? {};
            const modification = yield* modify(current);
            if (modification.write !== false)
              yield* writeObjectUnlocked(path, modification.document, modification.afterCommit);
            return modification.value;
          }),
        );
      });

      const updateObject: JsonDocumentStoreContract["updateObject"] = Effect.fn(
        "JsonDocumentStore.updateObject",
      )((path, update) =>
        modifyObject(path, (current) =>
          Effect.try({
            try: () => {
              const next = update(current);
              return { value: next, document: next } satisfies JsonDocumentModification<JsonObject>;
            },
            catch: mapError("update", path, "Unable to update JSON document."),
          }),
        ),
      );

      return JsonDocumentStore.of({ exists, readObject, writeObject, modifyObject, updateObject });
    }),
  );
}
