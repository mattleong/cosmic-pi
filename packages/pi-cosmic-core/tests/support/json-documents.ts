import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { JsonDocumentStore } from "../../src/platform/json-document.ts";
import { JsonDocumentLock } from "../../src/platform/json-document-lock.ts";

/** Leaves exclusion to the store's in-process serialization, for fake file systems. */
export const inProcessDocumentLock = Layer.succeed(JsonDocumentLock, {
  withLock: (_documentPath, effect) => effect,
});

const decodeCount = Schema.decodeUnknownOption(Schema.Finite);

/** One read-modify-write that loses an update unless writers exclude each other. */
export const incrementDocumentCount = (documentPath: string) =>
  JsonDocumentStore.use((store) =>
    store.modifyObject(documentPath, (document) =>
      Effect.succeed({
        value: undefined,
        document: {
          ...document,
          count: Option.match(decodeCount(document.count), {
            onNone: () => 1,
            onSome: (count) => count + 1,
          }),
        },
      }),
    ),
  );
