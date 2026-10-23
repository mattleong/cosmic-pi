import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { AgentDirectory, nodeFilePlatformLayer } from "pi-cosmic-core";
import { directoryModelPreference } from "../src/config/schema.ts";
import { DirectoryModelStore } from "../src/config/store.ts";

const encodeJsonDocument = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

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

  it.effect("decodes the thinking level apart from the fields a preference requires", () =>
    Effect.gen(function* () {
      const { fs, store, identity, readReason } = yield* storeFixture;
      const document = (thinkingLevel: Schema.Json, model: Schema.Json = "gpt") =>
        encodeJsonDocument({
          version: 1,
          cwd: identity.canonicalCwd,
          provider: "openai",
          model,
          thinkingLevel,
        }).pipe(Effect.flatMap((encoded) => fs.writeFileString(identity.preferencePath, encoded)));

      yield* document("none");
      expect(yield* store.read(identity)).toMatchObject({
        provider: "openai",
        model: "gpt",
        thinkingLevel: undefined,
        invalidThinkingLevel: true,
      });

      yield* document(null);
      expect(yield* store.read(identity)).toMatchObject({
        model: "gpt",
        thinkingLevel: undefined,
        invalidThinkingLevel: false,
      });

      yield* document("xhigh");
      expect(yield* store.read(identity)).toMatchObject({
        thinkingLevel: "xhigh",
        invalidThinkingLevel: false,
      });

      yield* document("high", 42);
      expect(yield* readReason).toBe("invalid");
    }),
  );

  it.effect("shares one identity across letter-case aliases on case-insensitive volumes", () =>
    Effect.gen(function* () {
      const { fs, store } = yield* storeFixture;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "pi-directory-models-case-" });
      const actual = path.join(parent, "Project");
      const alias = path.join(parent, "project");
      yield* fs.makeDirectory(actual);
      // Case sensitivity belongs to the volume, so the alias only exists where it applies.
      if (!(yield* fs.exists(alias))) return;

      const [fromActual, fromAlias] = yield* Effect.all([
        store.identify(actual),
        store.identify(alias),
      ]);
      expect(fromAlias).toEqual(fromActual);
      expect(path.basename(fromAlias.canonicalCwd)).toBe("Project");
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
