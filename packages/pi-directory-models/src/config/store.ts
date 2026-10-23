import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory } from "pi-cosmic-core/platform/agent-directory";
import { JsonDocumentStore } from "pi-cosmic-core/platform/json-document";
import { nodeFsPromises } from "pi-cosmic-core/platform/node-builtins";
import { preferenceFilename } from "./path-key.ts";
import {
  decodeSavedPreference,
  DirectoryModelPreferenceSchema,
  type DirectoryModelPreference,
} from "./schema.ts";

const STORE_DIRECTORY = "pi-directory-models";

export interface DirectoryIdentity {
  readonly canonicalCwd: string;
  readonly preferencePath: string;
}

export class DirectoryModelStoreError extends Schema.TaggedError<
  DirectoryModelStoreError,
  { readonly brand: unique symbol }
>()("DirectoryModelStoreError", {
  reason: Schema.Literals(["unreadable", "invalid", "foreign", "unwritable"]),
}) {}

const storeError = (reason: DirectoryModelStoreError["reason"]) => () =>
  DirectoryModelStoreError.make({ reason });

export class DirectoryModelStore extends Context.Service<DirectoryModelStore>()(
  "pi-directory-models/config/store/DirectoryModelStore",
  {
    make: Effect.gen(function* () {
      const paths = yield* Path.Path;
      const documents = yield* JsonDocumentStore;
      const agentDirectory = yield* AgentDirectory;

      const identify = Effect.fn("DirectoryModelStore.identify")(function* (cwd: string) {
        const lexical = paths.resolve(cwd);
        // Node's JavaScript realpath, which Effect's FileSystem uses, keeps the requested letter
        // case on case-insensitive volumes; the native resolver returns the stored case, so
        // case-only aliases share one preference.
        const canonicalCwd = yield* Effect.tryPromise({
          try: () => nodeFsPromises.realpath(lexical),
          catch: storeError("unreadable"),
        });
        const filename = preferenceFilename(canonicalCwd, paths.basename(canonicalCwd));
        return {
          canonicalCwd,
          preferencePath: paths.join(agentDirectory, STORE_DIRECTORY, filename),
        };
      });

      const read = Effect.fn("DirectoryModelStore.read")(function* (identity: DirectoryIdentity) {
        const raw = yield* documents
          .readObject(identity.preferencePath)
          .pipe(
            Effect.mapError((error) =>
              storeError(error.operation === "decode" ? "invalid" : "unreadable")(),
            ),
          );
        if (raw === undefined) return undefined;
        const preference = yield* decodeSavedPreference(raw).pipe(
          Effect.mapError(storeError("invalid")),
        );
        if (preference.cwd !== identity.canonicalCwd) return yield* storeError("foreign")();
        return preference;
      });

      const write = Effect.fn("DirectoryModelStore.write")(
        function* (identity: DirectoryIdentity, preference: DirectoryModelPreference) {
          const document = yield* Schema.encodeEffect(DirectoryModelPreferenceSchema)(preference);
          yield* documents.writeObject(identity.preferencePath, document);
        },
        Effect.mapError(storeError("unwritable")),
      );

      return { identify, read, write };
    }),
  },
) {}
