import * as Effect from "effect/Effect";
import { JsonDocumentStore, type JsonObject } from "../platform/json-document.ts";

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

/** Read and decode a JSON object document, returning undefined when absent. */
export const readOptionalJsonObject = <A, E>(
  path: string,
  decode: (value: JsonObject) => A,
  mapError: ConfigDocumentErrorFactory<E>,
): Effect.Effect<A | undefined, E, JsonDocumentStore> =>
  JsonDocumentStore.use((documents) =>
    documents.readObject(path).pipe(
      Effect.mapError(mapError("read", path)),
      Effect.map((raw) => (raw === undefined ? undefined : decode(raw))),
    ),
  );

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
