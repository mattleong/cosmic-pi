import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import {
  JsonDocumentError,
  JsonDocumentStore,
  nodePlatformLayer,
  provideBuiltLayer,
  type JsonDocumentStoreContract,
} from "pi-cosmic-core";
import { makeInMemoryDocuments } from "pi-cosmic-core/testing";
import { DEFAULT_CONFIG } from "../src/config/schema.ts";
import {
  configPaths,
  resolveConfig,
  setFooterVisibility,
  updateFooterConfig,
} from "../src/config/store.ts";

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
  }).pipe(Effect.scoped, provideBuiltLayer(nodePlatformLayer));

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

  it.effect("ignores untrusted project configuration and writes through the global document", () =>
    withTempConfig(({ cwd, agent }) =>
      Effect.gen(function* () {
        const documents = yield* JsonDocumentStore;
        const paths = yield* configPaths(cwd, agent);
        yield* documents.writeObject(paths.global, {
          footer: { enabled: true, density: "comfortable" },
        });
        yield* documents.writeObject(paths.project, {
          footer: { enabled: false, density: "compact" },
        });

        const config = yield* resolveConfig(cwd, agent, false);
        expect(config.configPath).toBe(paths.global);
        expect(config.footer).toMatchObject({ enabled: true, density: "comfortable" });
        const updated = yield* updateFooterConfig(cwd, agent, { enabled: false }, false);
        expect(updated.configPath).toBe(paths.global);
        expect(yield* documents.readObject(paths.project)).toEqual({
          footer: { enabled: false, density: "compact" },
        });
      }),
    ),
  );

  it.effect("omitted trust fails closed for resolution and writes", () => {
    const memory = makeInMemoryDocuments();
    const operations: string[] = [];
    const record =
      <Arguments extends unknown[], Result>(
        operation: string,
        method: (path: string, ...rest: Arguments) => Result,
      ) =>
      (path: string, ...rest: Arguments): Result => {
        operations.push(`${operation}:${path}`);
        return method(path, ...rest);
      };
    const service: JsonDocumentStoreContract = {
      exists: record("exists", memory.service.exists),
      readObject: record("read", memory.service.readObject),
      writeObject: record("write", memory.service.writeObject),
      modifyObject: (path, modify) => {
        operations.push(`modify:${path}`);
        return memory.service.modifyObject(path, modify);
      },
      updateObject: record("update", memory.service.updateObject),
    };
    return Effect.gen(function* () {
      const paths = yield* configPaths("/project", "/agent");
      memory.documents.set(paths.project, { footer: { enabled: false, density: "compact" } });
      memory.documents.set(paths.global, { footer: { density: "comfortable" } });

      const config = yield* resolveConfig("/project", "/agent");
      expect(config.configPath).toBe(paths.global);
      expect(config.footer).toMatchObject({ enabled: true, density: "comfortable" });

      const updated = yield* updateFooterConfig("/project", "/agent", { enabled: false });
      expect(updated.configPath).toBe(paths.global);
      expect(memory.documents.get(paths.global)).toEqual({
        footer: { density: "comfortable", enabled: false },
      });

      // The untrusted project document is never stat'd, read, or written.
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.filter((operation) => operation.includes(paths.project))).toEqual([]);
      expect(memory.documents.get(paths.project)).toEqual({
        footer: { enabled: false, density: "compact" },
      });
    }).pipe(provideBuiltLayer(Layer.merge(Layer.succeed(JsonDocumentStore, service), Path.layer)));
  });

  it.effect("reselects scope when external documents appear or disappear", () =>
    withTempConfig(({ cwd, agent }) =>
      Effect.gen(function* () {
        const documents = yield* JsonDocumentStore;
        const fs = yield* FileSystem.FileSystem;
        const paths = yield* configPaths(cwd, agent);
        yield* documents.writeObject(paths.global, {
          footer: { density: "comfortable", hidden: ["global-item"] },
        });
        const global = yield* resolveConfig(cwd, agent, true);
        expect(global.configPath).toBe(paths.global);

        yield* documents.writeObject(paths.project, {
          footer: { density: "auto", hidden: ["project-item"] },
        });
        const project = yield* updateFooterConfig(cwd, agent, { density: "compact" }, true);
        expect(project.configPath).toBe(paths.project);
        expect(yield* documents.readObject(paths.project)).toEqual({
          footer: { density: "compact", hidden: ["project-item"] },
        });
        expect(yield* documents.readObject(paths.global)).toEqual({
          footer: { density: "comfortable", hidden: ["global-item"] },
        });

        yield* fs.remove(paths.project);
        const next = yield* setFooterVisibility(cwd, agent, "metrics", false, true);
        expect(next.configPath).toBe(paths.global);
        expect(yield* fs.exists(paths.project)).toBe(false);
        expect(yield* documents.readObject(paths.global)).toEqual({
          footer: { density: "comfortable", hidden: ["global-item", "metrics"] },
        });
      }),
    ),
  );

  it.effect("logs a safe diagnostic when an existing config cannot be read", () => {
    const messages: string[] = [];
    const failure = new JsonDocumentError({
      operation: "read",
      path: "/secret/path",
      message: "credential=do-not-log",
    });
    const service: JsonDocumentStoreContract = {
      exists: () => Effect.succeed(true),
      readObject: () => Effect.fail(failure),
      writeObject: () => Effect.fail(failure),
      modifyObject: () => Effect.fail(failure),
      updateObject: () => Effect.fail(failure),
    };
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    return Effect.gen(function* () {
      const config = yield* resolveConfig("/project", "/agent");
      expect(config.footer.enabled).toBe(true);
      expect(messages.join(" ")).toContain("Unable to read a Cosmic UI configuration document");
      expect(messages.join(" ")).not.toContain("secret");
      expect(messages.join(" ")).not.toContain("credential");
    }).pipe(
      provideBuiltLayer(Layer.merge(Layer.succeed(JsonDocumentStore, service), Path.layer)),
      Effect.withLogger(logger),
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
