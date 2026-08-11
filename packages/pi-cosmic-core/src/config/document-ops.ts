import * as Effect from "effect/Effect";
import {
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "../platform/json-document.ts";

export type ConfigDocumentErrorFactory<E> = (operation: string, path: string) => () => E;

/** Standard "Unable to <operation> <label> configuration." factory for package config errors. */
export const makeConfigDocumentErrorFactory =
  <E>(
    Ctor: new (props: {
      readonly operation: string;
      readonly path: string;
      readonly message: string;
    }) => E,
    label: string,
  ): ConfigDocumentErrorFactory<E> =>
  (operation, path) =>
  () =>
    new Ctor({ operation, path, message: `Unable to ${operation} ${label} configuration.` });

/** Read a JSON object document, treating a missing file as `{}`. */
export const readRawJsonObject = <E>(
  path: string,
  mapError: ConfigDocumentErrorFactory<E>,
): Effect.Effect<JsonObject, E, JsonDocumentStore> =>
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    return yield* documents.readObject(path).pipe(
      Effect.mapError(mapError("read", path)),
      Effect.map((value) => value ?? {}),
    );
  });

/** Read and decode a JSON object document, returning undefined when absent. */
export const readOptionalJsonObject = <A, E>(
  path: string,
  decode: (value: JsonObject) => A,
  mapError: ConfigDocumentErrorFactory<E>,
): Effect.Effect<A | undefined, E, JsonDocumentStore> =>
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const raw = yield* documents.readObject(path).pipe(Effect.mapError(mapError("read", path)));
    return raw === undefined ? undefined : decode(raw);
  });

/** Overwrite a JSON object document. */
export const writeJsonObject = <E>(
  path: string,
  config: JsonObject,
  mapError: ConfigDocumentErrorFactory<E>,
): Effect.Effect<void, E, JsonDocumentStore> =>
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    yield* documents.writeObject(path, config).pipe(Effect.mapError(mapError("write", path)));
  });

/**
 * Atomically modify a JSON object through the document store's rename commit region.
 * Fails with the mapped write error when the store lacks modifyObject support.
 */
export const modifyJsonObject = <A, AfterCommitR, E>(
  path: string,
  modify: (document: JsonObject) => JsonDocumentModification<A, AfterCommitR>,
  mapError: ConfigDocumentErrorFactory<E>,
): Effect.Effect<A, E, JsonDocumentStore | AfterCommitR> =>
  Effect.gen(function* () {
    const documents = yield* JsonDocumentStore;
    const modifyObject = documents.modifyObject;
    if (modifyObject === undefined) {
      return yield* Effect.fail(mapError("write", path)());
    }
    return yield* modifyObject(path, (document) =>
      Effect.try({
        try: () => modify(document),
        catch: mapError("write", path),
      }),
    ).pipe(Effect.mapError(mapError("write", path)));
  });

/** Best-effort optional decode used while resolving layered project/global config. */
export const readConfigOrWarn = <A, E>(
  path: string,
  exists: boolean,
  read: (path: string) => Effect.Effect<A | undefined, E, JsonDocumentStore>,
  warning: string,
): Effect.Effect<A | undefined, never, JsonDocumentStore> =>
  Effect.gen(function* () {
    if (!exists) return undefined;
    return yield* read(path).pipe(
      Effect.catch(() => Effect.logWarning(warning).pipe(Effect.as(undefined))),
    );
  });
