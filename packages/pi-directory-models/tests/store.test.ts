import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { directoryModelPreference } from "../src/config/schema.ts";
import { DirectoryModelStore } from "../src/config/store.ts";

const storeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const agentDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "pi-directory-models-agent-",
  });
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "pi-directory-models-project-" });
  const store = yield* DirectoryModelStore.pipe(
    Effect.provide(
      Layer.effect(DirectoryModelStore, DirectoryModelStore.make).pipe(
        Layer.provide(AgentDirectory.layer(agentDirectory)),
      ),
    ),
  );
  const identity = yield* store.identify(cwd);
  yield* fs.makeDirectory(path.dirname(identity.preferencePath), { recursive: true });
  const readReason = store.read(identity).pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );
  return { fs, store, identity, readReason };
});

layer(nodeFilePlatformLayer)("directory model store", (it) => {
  it.effect("reports why a saved preference could not be used", () =>
    Effect.gen(function* () {
      const { fs, store, identity, readReason } = yield* storeFixture;
      expect(yield* store.read(identity)).toBeUndefined();

      yield* fs.writeFileString(identity.preferencePath, "{ not json");
      expect(yield* readReason).toBe("invalid");

      yield* fs.writeFileString(identity.preferencePath, `{ "version": 99 }`);
      expect(yield* readReason).toBe("invalid");

      yield* store.write(
        identity,
        directoryModelPreference("/somewhere/else", "openai", "gpt", "high"),
      );
      expect(yield* readReason).toBe("foreign");

      yield* fs.remove(identity.preferencePath);
      yield* fs.makeDirectory(identity.preferencePath);
      expect(yield* readReason).toBe("unreadable");
    }),
  );

  it.effect("reports unidentifiable directories as unreadable", () =>
    Effect.gen(function* () {
      const { store } = yield* storeFixture;
      const reason = yield* store.identify("/nonexistent/pi-directory-models").pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
      expect(reason).toBe("unreadable");
    }),
  );
});
