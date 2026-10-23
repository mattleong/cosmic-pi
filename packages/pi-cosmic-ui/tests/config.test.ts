import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import {
  JsonDocumentError,
  JsonDocumentStore,
  nodeFilePlatformLayer,
  type JsonDocumentStoreContract,
} from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeInMemoryDocuments,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import { configPaths, resolveConfig, updateFooterConfig } from "../src/config/store.ts";

const withTempConfig = <A, E>(
  run: (values: {
    root: string;
    cwd: string;
    agent: string;
  }) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | JsonDocumentStore>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cosmic-ui-" });
    const cwd = path.join(root, "project");
    const agent = path.join(root, "agent");
    yield* fs.makeDirectory(cwd, { recursive: true });
    return yield* run({ root, cwd, agent });
  }).pipe(Effect.scoped, provideBuiltLayer(nodeFilePlatformLayer));

describe("Cosmic UI config", () => {
  it.effect("does not seed defaults and marks the first footer update as global", () =>
    withTempConfig(({ cwd, agent }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* configPaths(cwd, agent);
        const config = yield* resolveConfig(cwd, agent, true);
        expect(config.configPath).toBe(paths.global);
        expect(config.projectConfigExists).toBe(false);
        expect(config.globalConfigExists).toBe(false);
        expect(config.footer).toEqual(DEFAULT_CONFIG.footer);
        expect(yield* fs.exists(paths.project)).toBe(false);
        expect(yield* fs.exists(paths.global)).toBe(false);

        const afterCommit: Array<typeof config> = [];
        const updated = yield* updateFooterConfig(cwd, agent, { enabled: false }, true, (next) =>
          Effect.sync(() => void afterCommit.push(next)),
        );
        const expectedMetadata = {
          configPath: paths.global,
          projectConfigPath: paths.project,
          globalConfigPath: paths.global,
          projectConfigExists: false,
          globalConfigExists: true,
        };
        expect(updated).toMatchObject({ ...expectedMetadata, footer: { enabled: false } });
        expect(afterCommit).toHaveLength(1);
        expect(afterCommit[0]).toMatchObject(expectedMetadata);
        expect(yield* fs.exists(paths.project)).toBe(false);
        expect(yield* fs.exists(paths.global)).toBe(true);
      }),
    ),
  );

  it.effect("merges valid fields independently and preserves unknown fields", () =>
    withTempConfig(({ cwd, agent }) =>
      Effect.gen(function* () {
        const documents = yield* JsonDocumentStore;
        const paths = yield* configPaths(cwd, agent);
        yield* documents.writeObject(paths.global, {
          footer: { enabled: false, density: "comfortable", hidden: ["metrics"] },
        });
        yield* documents.writeObject(paths.project, {
          custom: 42,
          footer: { density: "compact", enabled: "bad", future: true },
        });
        const config = yield* resolveConfig(cwd, agent, true);
        expect(config.footer).toMatchObject({
          enabled: false,
          density: "compact",
          hidden: ["metrics"],
        });
        yield* updateFooterConfig(cwd, agent, { enabled: true }, true);
        expect(yield* documents.readObject(paths.project)).toEqual({
          custom: 42,
          footer: { density: "compact", enabled: true, future: true },
        });
      }),
    ),
  );

  it.effect.each([false, undefined])(
    "project trust %s ignores the project document for resolution and writes",
    (trusted) => {
      const memory = makeInMemoryDocuments();
      return Effect.gen(function* () {
        const paths = yield* configPaths("/project", "/agent");
        memory.documents.set(paths.project, { footer: { enabled: false, density: "compact" } });
        memory.documents.set(paths.global, { footer: { density: "comfortable" } });

        const config = yield* resolveConfig("/project", "/agent", trusted);
        expect(config.configPath).toBe(paths.global);
        expect(config.footer).toMatchObject({ enabled: true, density: "comfortable" });

        const updated = yield* updateFooterConfig(
          "/project",
          "/agent",
          { enabled: false },
          trusted,
        );
        expect(updated.configPath).toBe(paths.global);
        expect(memory.documents.get(paths.global)).toEqual({
          footer: { density: "comfortable", enabled: false },
        });

        expect(memory.operations.length).toBeGreaterThan(0);
        expect(
          Arr.filter(memory.operations, (operation) =>
            Fn.pipe(operation, Str.includes(paths.project)),
          ),
        ).toEqual([]);
        expect(memory.documents.get(paths.project)).toEqual({
          footer: { enabled: false, density: "compact" },
        });
      }).pipe(provideBuiltLayer(Layer.merge(memory.layer, Path.layer)));
    },
  );

  it.effect("logs a safe diagnostic when an existing config cannot be read", () => {
    const captured = makeCapturedLogger();
    const failure = JsonDocumentError.make({
      operation: "read",
      path: "/secret/path",
      message: "credential=do-not-log",
    });
    const service: JsonDocumentStoreContract = {
      exists: () => Effect.succeed(true),
      readObject: () => Effect.fail(failure),
      writeObject: () => Effect.fail(failure),
      modifyObject: () => Effect.fail(failure),
    };
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent");
      expect(config.footer.enabled).toBe(true);
      const logged = capturedTelemetrySnapshot(captured);
      expect(logged).toContain("Unable to read a Cosmic UI configuration document");
      expect(logged).not.toContain("secret");
      expect(logged).not.toContain("credential");
    }).pipe(
      provideBuiltLayer(
        Layer.mergeAll(Layer.succeed(JsonDocumentStore, service), Path.layer, captured.layer),
      ),
    );
  });

  it.effect("falls back on malformed config and refuses to overwrite it", () =>
    withTempConfig(({ cwd, agent }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* configPaths(cwd, agent);
        yield* fs.makeDirectory((yield* Path.Path).dirname(paths.project), { recursive: true });
        yield* fs.writeFileString(paths.project, "{not-json");
        const config = yield* resolveConfig(cwd, agent, true);
        expect(config.footer.enabled).toBe(true);
        expect(config.configPath).toBe(paths.project);
        expect(
          yield* Effect.exit(updateFooterConfig(cwd, agent, { enabled: false }, true)).pipe(
            Effect.map((exit) => exit._tag),
          ),
        ).toBe("Failure");
        expect(yield* fs.readFileString(paths.project)).toBe("{not-json");
      }),
    ),
  );
});
