import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Semaphore from "effect/Semaphore";
import * as Random from "effect/Random";
import { JsonDocumentError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

const UnknownFromPrettyJsonString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Unknown,
    new SchemaTransformation.Transformation<unknown, string>(
      SchemaGetter.parseJson(),
      SchemaGetter.stringifyJson({ space: 2 }),
    ),
  ),
);
const JsonObjectFromString = UnknownFromPrettyJsonString.pipe(
  Schema.decodeTo(Schema.Record(Schema.String, Schema.Unknown)),
);

export interface JsonDocumentStoreShape {
  readonly exists: (path: string) => Effect.Effect<boolean, JsonDocumentError>;
  readonly readObject: (path: string) => Effect.Effect<JsonObject | undefined, JsonDocumentError>;
  readonly writeObject: (
    path: string,
    document: JsonObject,
  ) => Effect.Effect<void, JsonDocumentError>;
  readonly updateObject: (
    path: string,
    update: (document: JsonObject) => JsonObject,
  ) => Effect.Effect<JsonObject, JsonDocumentError>;
}

export class JsonDocumentStore extends Context.Service<JsonDocumentStore, JsonDocumentStoreShape>()(
  "pi-cosmic-core/platform/json-document/JsonDocumentStore",
) {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const writeLock = yield* Semaphore.make(1);

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
        if (!(yield* exists(path))) return undefined;
        const source = yield* fs
          .readFileString(path)
          .pipe(Effect.mapError(mapError("read", path, "Unable to read JSON document.")));
        return yield* Schema.decodeUnknownEffect(JsonObjectFromString)(source).pipe(
          Effect.mapError(mapError("decode", path, "JSON document must contain an object.")),
        );
      });

      const readObject = Effect.fn("JsonDocumentStore.readObject")(function* (path: string) {
        return yield* readObjectUnlocked(path);
      });

      const encodeObject = (path: string, document: JsonObject) =>
        Schema.encodeUnknownEffect(JsonObjectFromString)(document).pipe(
          Effect.mapError(mapError("encode", path, "Unable to encode JSON document.")),
        );

      const writeObjectUnlocked = Effect.fn("JsonDocumentStore.writeObjectUnlocked")(function* (
        path: string,
        document: JsonObject,
      ) {
        const source = yield* encodeObject(path, document);
        const directory = pathService.dirname(path);
        yield* fs
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.mapError(mapError("mkdir", path, "Unable to create JSON document directory.")),
          );
        const nonce = [
          yield* Random.nextIntBetween(0, 0xffff_ffff),
          yield* Random.nextIntBetween(0, 0xffff_ffff),
        ]
          .map((value) => value.toString(16).padStart(8, "0"))
          .join("");
        const temporary = pathService.join(
          directory,
          `.${pathService.basename(path)}.${nonce}.tmp`,
        );
        yield* Effect.acquireUseRelease(
          Effect.succeed(temporary),
          (temporaryPath) =>
            fs
              .writeFileString(temporaryPath, `${source}\n`)
              .pipe(
                Effect.mapError(
                  mapError("write", path, "Unable to write temporary JSON document."),
                ),
                Effect.andThen(
                  fs
                    .rename(temporaryPath, path)
                    .pipe(
                      Effect.mapError(
                        mapError("rename", path, "Unable to replace JSON document atomically."),
                      ),
                    ),
                ),
              ),
          (temporaryPath) => fs.remove(temporaryPath).pipe(Effect.catch(() => Effect.void)),
        );
      });

      const writeObject = Effect.fn("JsonDocumentStore.writeObject")(function* (
        path: string,
        document: JsonObject,
      ) {
        yield* writeLock.withPermits(1)(writeObjectUnlocked(path, document));
      });

      const updateObject = Effect.fn("JsonDocumentStore.updateObject")(function* (
        path: string,
        update: (document: JsonObject) => JsonObject,
      ) {
        return yield* writeLock.withPermits(1)(
          Effect.gen(function* () {
            const current = (yield* readObjectUnlocked(path)) ?? {};
            const next = yield* Effect.try({
              try: () => update(current),
              catch: mapError("update", path, "Unable to update JSON document."),
            });
            yield* writeObjectUnlocked(path, next);
            return next;
          }),
        );
      });

      return JsonDocumentStore.of({ exists, readObject, writeObject, updateObject });
    }),
  );
}
