import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { JsonDocumentError } from "./errors.ts";
import { withProcessLock } from "./process-coordinator.ts";

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

const documentError = (operation: string, path: string, message: string) =>
  new JsonDocumentError({ operation, path, message });
const failAs = (operation: string, path: string, message: string) =>
  Effect.mapError(() => documentError(operation, path, message));

export interface JsonDocumentStoreContract {
  readonly exists: (path: string) => Effect.Effect<boolean, JsonDocumentError>;
  readonly readObject: (path: string) => Effect.Effect<JsonObject | undefined, JsonDocumentError>;
  readonly writeObject: (
    path: string,
    document: JsonObject,
  ) => Effect.Effect<void, JsonDocumentError>;
  /** Effectful read-modify-write transaction under the per-path process lock. */
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

      const exists = Effect.fn("JsonDocumentStore.exists")((path: string) =>
        fs.exists(path).pipe(failAs("exists", path, "Unable to inspect JSON document path.")),
      );

      const readObject = Effect.fn("JsonDocumentStore.readObject")(function* (path: string) {
        const source = yield* fs.readFileString(path).pipe(
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.succeed(undefined),
            () => Effect.fail(documentError("read", path, "Unable to read JSON document.")),
          ),
        );
        if (source === undefined) return undefined;
        return yield* Schema.decodeEffect(JsonObjectFromString)(source).pipe(
          failAs("decode", path, "JSON document must contain an object."),
        );
      });

      const writeObjectUnlocked = Effect.fn("JsonDocumentStore.writeObjectUnlocked")(function* <
        AfterCommitR,
      >(
        path: string,
        document: JsonObject,
        afterCommit?: Effect.Effect<void, never, AfterCommitR>,
      ) {
        const source = yield* Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
          failAs("encode", path, "Unable to encode JSON document."),
        );
        const directory = pathService.dirname(path);
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(failAs("mkdir", path, "Unable to create JSON document directory."));
        yield* Effect.scoped(
          Effect.gen(function* () {
            const temporaryPath = yield* Effect.acquireRelease(
              fs
                .makeTempFile({
                  directory,
                  prefix: `.${pathService.basename(path)}.`,
                  suffix: ".tmp",
                })
                .pipe(failAs("write", path, "Unable to create temporary JSON document.")),
              (ownedPath) =>
                fs
                  .remove(pathService.dirname(ownedPath), { recursive: true })
                  .pipe(Effect.ignoreCause),
            );
            yield* fs
              .writeFileString(temporaryPath, `${source}\n`, { mode: 0o600 })
              .pipe(failAs("write", path, "Unable to write temporary JSON document."));
            yield* fs
              .chmod(temporaryPath, 0o600)
              .pipe(failAs("chmod", path, "Unable to protect temporary JSON document."));
            yield* fs
              .rename(temporaryPath, path)
              .pipe(
                Effect.andThen(afterCommit ?? Effect.void),
                failAs("rename", path, "Unable to replace JSON document atomically."),
                Effect.uninterruptible,
              );
          }),
        );
      });

      const writeObject = Effect.fn("JsonDocumentStore.writeObject")(
        (path: string, document: JsonObject) =>
          withProcessLock(
            pathService.resolve(path),
            writeObjectUnlocked(path, document, Effect.void),
          ),
      );

      const modifyObject: JsonDocumentStoreContract["modifyObject"] = Effect.fn(
        "JsonDocumentStore.modifyObject",
      )(function* <A, E, R, AfterCommitR = never>(
        path: string,
        modify: (
          document: JsonObject,
        ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
      ) {
        return yield* withProcessLock(
          pathService.resolve(path),
          Effect.gen(function* () {
            const current = (yield* readObject(path)) ?? {};
            const modification = yield* modify(current);
            if (modification.write !== false)
              yield* writeObjectUnlocked(path, modification.document, modification.afterCommit);
            return modification.value;
          }),
        );
      });

      return JsonDocumentStore.of({ exists, readObject, writeObject, modifyObject });
    }),
  );
}
