import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory, nodeFilePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { capturedTelemetrySnapshot, makeCapturedLogger } from "pi-cosmic-core/testing";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import {
  BackgroundTaskConfigError,
  BackgroundTaskConfigStore,
  BackgroundTaskSettingsFiles,
  type BackgroundTaskSettingsLocation,
} from "../src/config/store.ts";

const SECRET = "sk-background-config-secret";

/** A global settings file with the given source, under a scoped temporary agent directory. */
const globalDocument = (source: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "pi-background-config-" });
    const agentDirectory = path.join(root, "agent");
    const cwd = path.join(root, "project");
    const file = path.join(agentDirectory, "extensions", "pi-background-task.json");
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, source);
    const location: BackgroundTaskSettingsLocation = { cwd, scope: "global" };
    return {
      file,
      location,
      contents: fs.readFileString(file),
      // The same composition the session layer uses, over the real document store.
      layer: Layer.merge(
        BackgroundTaskConfigStore.layer({ cwd, projectTrusted: false }),
        BackgroundTaskSettingsFiles.layer,
      ).pipe(Layer.provide(AgentDirectory.layer(agentDirectory))),
    };
  });

layer(nodeFilePlatformLayer)("background task config documents on disk", (it) => {
  it.effect.each([
    { name: "malformed JSON", source: `{"maxRunning": 4, "shellPath": "${SECRET}"` },
    { name: "a non-object document", source: `["${SECRET}"]` },
  ])("$name resolves to defaults and is never overwritten by a write", ({ source }) =>
    Effect.gen(function* () {
      const document = yield* globalDocument(source);
      const captured = makeCapturedLogger();
      const { config, files } = yield* Effect.all({
        config: BackgroundTaskConfigStore.use(Effect.succeed),
        files: BackgroundTaskSettingsFiles.use(Effect.succeed),
      }).pipe(provideBuiltLayer(document.layer.pipe(Layer.provide(captured.layer))));

      expect(config).toEqual(DEFAULT_BACKGROUND_TASK_CONFIG);
      expect(captured.entries.length).toBeGreaterThan(0);
      expect(capturedTelemetrySnapshot(captured)).not.toContain(SECRET);

      const readFailure = yield* Effect.flip(files.read(document.location));
      expect(readFailure).toBeInstanceOf(BackgroundTaskConfigError);
      expect(readFailure).toMatchObject({ operation: "read", path: document.file });
      expect(readFailure.message).not.toContain(SECRET);

      const writeFailure = yield* Effect.flip(files.write(document.location, "maxRunning", 16));
      expect(writeFailure).toBeInstanceOf(BackgroundTaskConfigError);
      expect(writeFailure).toMatchObject({ operation: "write", path: document.file });
      expect(yield* document.contents).toBe(source);
    }),
  );
});
