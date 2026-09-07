import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory, JsonDocumentStore } from "pi-cosmic-core";
import { preferenceFilename } from "./path-key.ts";
import { DirectoryModelPreferenceSchema, type DirectoryModelPreference } from "./schema.ts";

const STORE_DIRECTORY = "pi-directory-models";

export interface DirectoryIdentity {
  readonly canonicalCwd: string;
  readonly preferencePath: string;
}

/** Callers only branch on store failure itself, so the error carries no payload. */
export class DirectoryModelStoreError extends Schema.TaggedError<DirectoryModelStoreError>()(
  "DirectoryModelStoreError",
  {},
) {}

const storeError = () => new DirectoryModelStoreError();

export class DirectoryModelStore extends Context.Service<DirectoryModelStore>()(
  "pi-directory-models/config/store/DirectoryModelStore",
  {
    make: Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const documents = yield* JsonDocumentStore;
      const agentDirectory = yield* AgentDirectory;

      const identify = Effect.fn("DirectoryModelStore.identify")(function* (cwd: string) {
        const lexical = paths.resolve(cwd);
        const canonicalCwd = yield* fs.realPath(lexical).pipe(Effect.mapError(storeError));
        const filename = preferenceFilename(canonicalCwd, paths.basename(canonicalCwd));
        return {
          canonicalCwd,
          preferencePath: paths.join(agentDirectory, STORE_DIRECTORY, filename),
        };
      });

      const read = Effect.fn("DirectoryModelStore.read")(function* (identity: DirectoryIdentity) {
        const raw = yield* documents
          .readObject(identity.preferencePath)
          .pipe(Effect.mapError(storeError));
        if (raw === undefined) return undefined;
        const preference = yield* Schema.decodeUnknownEffect(DirectoryModelPreferenceSchema)(
          raw,
        ).pipe(Effect.mapError(storeError));
        if (preference.cwd !== identity.canonicalCwd) return yield* storeError();
        return preference;
      });

      const write = Effect.fn("DirectoryModelStore.write")(function* (
        identity: DirectoryIdentity,
        preference: DirectoryModelPreference,
      ) {
        const document = yield* Schema.encodeEffect(DirectoryModelPreferenceSchema)(preference);
        yield* documents.writeObject(identity.preferencePath, document);
      }, Effect.mapError(storeError));

      return { identify, read, write };
    }),
  },
) {}
