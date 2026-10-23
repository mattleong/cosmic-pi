import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { JsonDocumentError } from "./errors.ts";
import { JsonDocumentLock, type JsonDocumentLockError } from "./json-document-lock.ts";
import { withProcessLock } from "./process-coordinator.ts";

export type JsonValue = Schema.MutableJson;

export type JsonObject = Schema.MutableJsonObject;

const isMutableJson = Schema.is(Schema.MutableJson);

export const isJsonObject = <Value>(value: Value): value is Value & JsonObject =>
  isMutableJson(value) && Predicate.isObject(value);

export interface JsonDocumentModification<A, AfterCommitR = never> {
  readonly value: A;
  readonly document: JsonObject;
  readonly write?: boolean | undefined;
  readonly afterCommit?: Effect.Effect<void, never, AfterCommitR>;
}

const JsonObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);
export const JsonObjectFromString = Schema.fromJsonString(JsonObjectSchema, { space: 2 });

const documentError = (operation: string, path: string, message: string) =>
  new JsonDocumentError({ operation, path, message });
const failAs = (operation: string, path: string, message: string) =>
  Effect.mapError(() => documentError(operation, path, message));

// Matches the kernel's symlink-resolution limit, so a link loop fails instead of spinning.
const MAX_SYMLINK_HOPS = 40;
const isInvalidArgument = Schema.is(Schema.Struct({ code: Schema.Literal("EINVAL") }));
// readlink reports EINVAL for an existing path that is not a symlink.
const isNotSymlink = (error: PlatformError.PlatformError) =>
  Predicate.isTagged(error.reason, "NotFound") || isInvalidArgument(error.reason.cause);

const lockMessage = (error: JsonDocumentLockError): string => {
  if (error.reason === "busy") return "Another process kept the JSON document locked.";
  if (error.reason === "unavailable") return "Unable to lock the JSON document.";
  return error.slot === undefined
    ? "The JSON document lock needs manual recovery."
    : `The JSON document lock needs manual recovery; remove ${error.slot} once no process is writing the document.`;
};

export interface JsonDocumentStoreContract {
  readonly exists: (path: string) => Effect.Effect<boolean, JsonDocumentError>;
  readonly readObject: (path: string) => Effect.Effect<JsonObject | undefined, JsonDocumentError>;
  readonly writeObject: (
    path: string,
    document: JsonObject,
  ) => Effect.Effect<void, JsonDocumentError>;
  readonly modifyObject: <A, E, R, AfterCommitR = never>(
    path: string,
    modify: (
      document: JsonObject,
    ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
  ) => Effect.Effect<A, JsonDocumentError | E, R | AfterCommitR>;
}

const makeJsonDocumentStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const lock = yield* JsonDocumentLock;

  const exists = Effect.fn("JsonDocumentStore.exists")((path: string) =>
    fs.exists(path).pipe(failAs("exists", path, "Unable to inspect JSON document path.")),
  );

  const readDocument = Effect.fnUntraced(function* (readPath: string, path: string) {
    const source = yield* fs.readFileString(readPath).pipe(
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () => Effect.undefined,
        () => Effect.fail(documentError("read", path, "Unable to read JSON document.")),
      ),
    );
    if (source === undefined) return undefined;
    return yield* Schema.decodeEffect(JsonObjectFromString)(source).pipe(
      failAs("decode", path, "JSON document must contain an object."),
    );
  });

  const readObject = Effect.fn("JsonDocumentStore.readObject")((path: string) =>
    readDocument(path, path),
  );

  const resolveFailure = (path: string) =>
    documentError("resolve", path, "Unable to resolve the JSON document location.");

  /** The real path of `directory`, through its nearest existing ancestor when it is missing. */
  const canonicalDirectory = Effect.fnUntraced(function* (directory: string, path: string) {
    const missing: Array<string> = [];
    let current = directory;
    for (;;) {
      const real = yield* fs.realPath(current).pipe(
        Effect.asSome,
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => Effect.succeedNone,
          () => Effect.fail(resolveFailure(path)),
        ),
      );
      if (Option.isSome(real)) return pathService.join(real.value, ...missing.toReversed());
      const parent = pathService.dirname(current);
      if (parent === current) return directory;
      missing.push(pathService.basename(current));
      current = parent;
    }
  });

  /**
   * The file a write replaces. Symlinks are followed, so a linked document (for example one
   * kept by a dotfile manager) stays a link and its target receives the update. A dangling
   * link resolves to its missing target, as an ordinary file write would.
   */
  const resolveDocumentTarget = Effect.fnUntraced(function* (path: string) {
    let target = pathService.resolve(path);
    for (let hop = 0; ; hop++) {
      const directory = yield* canonicalDirectory(pathService.dirname(target), path);
      target = pathService.join(directory, pathService.basename(target));
      const link = yield* fs.readLink(target).pipe(
        Effect.asSome,
        Effect.catch((error) =>
          isNotSymlink(error) ? Effect.succeedNone : Effect.fail(resolveFailure(path)),
        ),
      );
      if (Option.isNone(link)) return target;
      if (hop === MAX_SYMLINK_HOPS)
        return yield* documentError("resolve", path, "JSON document symlinks form a loop.");
      target = pathService.resolve(directory, link.value);
    }
  });

  /** Serializes one real document within this process, then across processes. */
  const withDocumentLock = <A, E, R>(
    path: string,
    effect: (target: string) => Effect.Effect<A, E, R>,
  ) =>
    resolveDocumentTarget(path).pipe(
      Effect.flatMap((target) =>
        withProcessLock(
          target,
          fs.makeDirectory(pathService.dirname(target), { recursive: true, mode: 0o700 }).pipe(
            failAs("mkdir", path, "Unable to create JSON document directory."),
            Effect.andThen(
              lock
                .withLock(target, Effect.exit(effect(target)))
                .pipe(Effect.mapError((error) => documentError("lock", path, lockMessage(error)))),
            ),
            Effect.flatMap((exit) => exit),
          ),
        ),
      ),
    );

  const writeObjectUnlocked = Effect.fn("JsonDocumentStore.writeObjectUnlocked")(function* <
    AfterCommitR,
  >(
    target: string,
    path: string,
    document: JsonObject,
    afterCommit?: Effect.Effect<void, never, AfterCommitR>,
  ) {
    const source = yield* Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
      failAs("encode", path, "Unable to encode JSON document."),
    );
    const directory = pathService.dirname(target);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temporaryPath = yield* Effect.acquireRelease(
          fs
            .makeTempFile({
              directory,
              prefix: `.${pathService.basename(target)}.`,
              suffix: ".tmp",
            })
            .pipe(failAs("write", path, "Unable to create temporary JSON document.")),
          (ownedPath) =>
            fs.remove(pathService.dirname(ownedPath), { recursive: true }).pipe(Effect.ignoreCause),
        );
        yield* fs
          .writeFileString(temporaryPath, `${source}\n`, { mode: 0o600 })
          .pipe(failAs("write", path, "Unable to write temporary JSON document."));
        yield* fs
          .chmod(temporaryPath, 0o600)
          .pipe(failAs("chmod", path, "Unable to protect temporary JSON document."));
        yield* fs
          .rename(temporaryPath, target)
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
      withDocumentLock(path, (target) => writeObjectUnlocked(target, path, document, Effect.void)),
  );

  const modifyObject: JsonDocumentStoreContract["modifyObject"] = Effect.fn(
    "JsonDocumentStore.modifyObject",
  )(function* <A, E, R, AfterCommitR = never>(
    path: string,
    modify: (
      document: JsonObject,
    ) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
  ) {
    return yield* withDocumentLock(path, (target) =>
      Effect.gen(function* () {
        const current = (yield* readDocument(target, path)) ?? {};
        const modification = yield* modify(current);
        if (modification.write !== false)
          yield* writeObjectUnlocked(target, path, modification.document, modification.afterCommit);
        return modification.value;
      }),
    );
  });

  return { exists, readObject, writeObject, modifyObject } satisfies JsonDocumentStoreContract;
});

export class JsonDocumentStore extends Context.Service<
  JsonDocumentStore,
  JsonDocumentStoreContract
>()("pi-cosmic-core/platform/json-document/JsonDocumentStore") {
  /** The store over a supplied cross-process document lock. */
  static readonly layerWith = (
    lock: Layer.Layer<JsonDocumentLock>,
  ): Layer.Layer<JsonDocumentStore, never, FileSystem.FileSystem | Path.Path> =>
    Layer.effect(this, makeJsonDocumentStore).pipe(Layer.provide(lock));

  static readonly layer = this.layerWith(JsonDocumentLock.layer);
}
