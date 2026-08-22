import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory, JsonDocumentStore } from "pi-cosmic-core";
import { preferenceFilename } from "../boundary/path-key.ts";
import { DirectoryModelPreferenceSchema, type DirectoryModelPreference } from "./schema.ts";

const STORE_DIRECTORY = "pi-directory-models";

export interface DirectoryIdentity {
  readonly canonicalCwd: string;
  readonly preferencePath: string;
}

export class DirectoryModelStoreError extends Schema.TaggedError<DirectoryModelStoreError>()(
  "DirectoryModelStoreError",
  { operation: Schema.String, message: Schema.String },
) {}

const storeError = (operation: string, message: string) => () =>
  new DirectoryModelStoreError({ operation, message });

export interface DirectoryModelStoreContract {
  readonly identify: (cwd: string) => Effect.Effect<DirectoryIdentity, DirectoryModelStoreError>;
  readonly read: (
    identity: DirectoryIdentity,
  ) => Effect.Effect<DirectoryModelPreference | undefined, DirectoryModelStoreError>;
  readonly write: (
    identity: DirectoryIdentity,
    preference: DirectoryModelPreference,
  ) => Effect.Effect<void, DirectoryModelStoreError>;
}

export class DirectoryModelStore extends Context.Service<
  DirectoryModelStore,
  DirectoryModelStoreContract
>()("pi-directory-models/config/store/DirectoryModelStore") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const documents = yield* JsonDocumentStore;
      const agentDirectory = yield* AgentDirectory;

      const identify = Effect.fn("DirectoryModelStore.identify")(function* (cwd: string) {
        const lexical = paths.resolve(cwd);
        const canonicalCwd = yield* fs
          .realPath(lexical)
          .pipe(
            Effect.mapError(storeError("identify", "Unable to resolve the working directory.")),
          );
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
            Effect.mapError(storeError("read", "Unable to read the directory model preference.")),
          );
        if (raw === undefined) return undefined;
        const preference = yield* Schema.decodeUnknownEffect(DirectoryModelPreferenceSchema)(
          raw,
        ).pipe(Effect.mapError(storeError("decode", "The directory model preference is invalid.")));
        if (preference.cwd !== identity.canonicalCwd)
          return yield* storeError(
            "identity",
            "The directory model preference belongs to another path.",
          )();
        return preference;
      });

      const write = Effect.fn("DirectoryModelStore.write")(function* (
        identity: DirectoryIdentity,
        preference: DirectoryModelPreference,
      ) {
        const document = yield* Schema.encodeEffect(DirectoryModelPreferenceSchema)(
          preference,
        ).pipe(
          Effect.mapError(storeError("encode", "Unable to encode the directory model preference.")),
        );
        yield* documents
          .writeObject(identity.preferencePath, document)
          .pipe(
            Effect.mapError(storeError("write", "Unable to save the directory model preference.")),
          );
      });

      return DirectoryModelStore.of({ identify, read, write });
    }),
  );
}
