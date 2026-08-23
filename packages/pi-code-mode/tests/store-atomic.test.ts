// Deterministic atomic-commit suite: one long-lived Layer per test owns the store runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  AgentDirectory,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonDocumentStoreContract,
} from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import { CodeModeConfigStore, type CodeModeState } from "../src/config/store.ts";

const GLOBAL_PATH = "/agent/extensions/pi-code-mode.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-code-mode.json";

const storeLayer = (
  memory: InMemoryDocuments,
  projectTrusted: boolean,
  publish?: (state: CodeModeState) => void,
) => {
  const baseLayer = CodeModeConfigStore.layer({ cwd: "/project", projectTrusted });
  const layer = publish
    ? CodeModeConfigStore.layer({ cwd: "/project", projectTrusted, publish })
    : baseLayer;
  return layer.pipe(
    Layer.provide(Layer.mergeAll(memory.layer, Path.layer, AgentDirectory.layer("/agent"))),
  );
};

describe("code mode store atomic publication", () => {
  it.effect("publishes the committed document before interruption is observable", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL_PATH]: { timeoutMs: 15_000, future: true } });
    const published: CodeModeState[] = [];
    const layer = storeLayer(memory, true, (state) => published.push(state));
    return Effect.gen(function* () {
      const store = yield* CodeModeConfigStore;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      memory.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const setting = yield* store
        .setSetting("global", "timeoutMs", "60000")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      // Interrupt exactly at the after-commit boundary: the document is already renamed,
      // publication has not run yet, and the region is uninterruptible.
      const interruption = yield* Fiber.interrupt(setting).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(interruption);

      expect(memory.documents.get(GLOBAL_PATH)).toEqual({ timeoutMs: 60_000, future: true });
      expect(store.snapshot().config.timeoutMs).toBe(60_000);
      expect(published.at(-1)?.config.timeoutMs).toBe(60_000);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect(
    "maps a hostile publish callback onto a typed failure without stale publication",
    () => {
      const memory = makeInMemoryDocuments({ [GLOBAL_PATH]: { timeoutMs: 15_000 } });
      const published: CodeModeState[] = [];
      let hostile = false;
      const layer = storeLayer(memory, true, (state) => {
        if (hostile) throw new Error("hostile publish callback");
        published.push(state);
      });
      return Effect.gen(function* () {
        const store = yield* CodeModeConfigStore;
        hostile = true;
        const error = yield* store.setSetting("global", "timeoutMs", "60000").pipe(Effect.flip);
        expect(error._tag).toBe("CodeModeConfigError");
        if (error._tag === "CodeModeConfigError") expect(error.operation).toBe("publish");
        // The document is committed, but neither the snapshot nor the boundary publication
        // silently advanced: the previous state stays authoritative until a publish succeeds.
        expect(memory.documents.get(GLOBAL_PATH)).toEqual({ timeoutMs: 60_000 });
        expect(store.snapshot().config.timeoutMs).toBe(15_000);
        expect(published.at(-1)?.config.timeoutMs).toBe(15_000);

        hostile = false;
        const next = yield* store.setSetting("global", "maxToolCalls", "8");
        // Recovery re-derives from the committed document; nothing is lost or rolled back.
        expect(next.config.timeoutMs).toBe(60_000);
        expect(next.config.maxToolCalls).toBe(8);
        expect(published.at(-1)?.config.timeoutMs).toBe(60_000);
      }).pipe(Effect.scoped, provideBuiltLayer(layer));
    },
  );

  it.effect("serializes concurrent settings writes so older state never overwrites newer", () => {
    const memory = makeInMemoryDocuments({ [GLOBAL_PATH]: {} });
    const published: CodeModeState[] = [];
    const layer = storeLayer(memory, true, (state) => published.push(state));
    return Effect.gen(function* () {
      const store = yield* CodeModeConfigStore;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      memory.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const first = yield* store.setSetting("global", "timeoutMs", "60000").pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      const second = yield* store
        .setSetting("global", "maxToolCalls", "64")
        .pipe(Effect.forkScoped);
      for (let index = 0; index < 100 && memory.updateCount < 2; index++) yield* Effect.yieldNow;
      // The second write must wait for the first commit's serialized region.
      expect(memory.updateCount).toBe(1);

      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      expect(memory.documents.get(GLOBAL_PATH)).toEqual({ timeoutMs: 60_000, maxToolCalls: 64 });
      const final = store.snapshot();
      expect(final.config.timeoutMs).toBe(60_000);
      expect(final.config.maxToolCalls).toBe(64);
      expect(published.at(-1)?.config.timeoutMs).toBe(60_000);
      expect(published.at(-1)?.config.maxToolCalls).toBe(64);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("resolves committed state from pre-commit data with no post-commit reads", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: {},
      [PROJECT_PATH]: { timeoutMs: 1_000 },
    });
    const published: CodeModeState[] = [];
    const layer = storeLayer(memory, true, (state) => published.push(state));
    return Effect.gen(function* () {
      const store = yield* CodeModeConfigStore;
      const commitStarted = yield* Deferred.make<void>();
      const releaseCommit = yield* Deferred.make<void>();
      memory.blockNextUpdateAtCommit(commitStarted, releaseCommit);

      const setting = yield* store
        .setSetting("global", "maxToolCalls", "8")
        .pipe(Effect.forkScoped);
      yield* Deferred.await(commitStarted);
      // Hostile external mutation after the commit point: a post-commit re-read would see it.
      memory.documents.set(PROJECT_PATH, { timeoutMs: 2_000 });
      yield* Deferred.succeed(releaseCommit, undefined);
      yield* Fiber.join(setting);

      const final = store.snapshot();
      expect(final.projectValues).toEqual({ timeoutMs: 1_000 });
      expect(final.config.timeoutMs).toBe(1_000);
      expect(final.config.maxToolCalls).toBe(8);
      expect(published.at(-1)?.config.timeoutMs).toBe(1_000);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });

  it.effect("overlays scopes field-wise across writes in one long-lived runtime", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: { timeoutMs: 60_000, enabled: false, future: { keep: true } },
    });
    const published: CodeModeState[] = [];
    const layer = storeLayer(memory, true, (state) => published.push(state));
    return Effect.gen(function* () {
      const store = yield* CodeModeConfigStore;
      // Creating the previously absent project document keeps the global fallback overlay.
      const afterProject = yield* store.setSetting("project", "timeoutMs", "45000");
      expect(afterProject.config.timeoutMs).toBe(45_000);
      expect(afterProject.provenance.timeoutMs).toBe("project");
      expect(afterProject.config.enabled).toBe(false);
      expect(afterProject.provenance.enabled).toBe("global");
      expect(memory.documents.get(PROJECT_PATH)).toEqual({ timeoutMs: 45_000 });

      // Global writes retain trusted project values.
      const afterGlobal = yield* store.setSetting("global", "maxToolCalls", "16");
      expect(afterGlobal.config.timeoutMs).toBe(45_000);
      expect(afterGlobal.provenance.timeoutMs).toBe("project");
      expect(afterGlobal.config.maxToolCalls).toBe(16);
      expect(memory.documents.get(GLOBAL_PATH)).toEqual({
        timeoutMs: 60_000,
        enabled: false,
        future: { keep: true },
        maxToolCalls: 16,
      });

      const afterClear = yield* store.clearSetting("project", "timeoutMs");
      expect(afterClear.config.timeoutMs).toBe(60_000);
      expect(afterClear.provenance.timeoutMs).toBe("global");
      expect(Object.isFrozen(published.at(-1))).toBe(true);
      expect(Object.isFrozen(published.at(-1)?.config)).toBe(true);
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});

describe("code mode untrusted project I/O", () => {
  const recordingLayer = (memory: InMemoryDocuments, operations: string[]) => {
    const record = (operation: string, path: string) => operations.push(`${operation}:${path}`);
    const service: JsonDocumentStoreContract = {
      exists: (path) => {
        record("exists", path);
        return memory.service.exists(path);
      },
      readObject: (path) => {
        record("read", path);
        return memory.service.readObject(path);
      },
      writeObject: (path, document) => {
        record("write", path);
        return memory.service.writeObject(path, document);
      },
      modifyObject: (path, modify) => {
        record("modify", path);
        return memory.service.modifyObject(path, modify);
      },
      updateObject: (path, update) => {
        record("update", path);
        return memory.service.updateObject(path, update);
      },
    };
    return Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service));
  };

  it.effect("performs no project-document I/O at all while the project is untrusted", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: { timeoutMs: 45_000 },
      [PROJECT_PATH]: { enabled: true, timeoutMs: 1_000 },
    });
    const operations: string[] = [];
    const layer = CodeModeConfigStore.layer({ cwd: "/project", projectTrusted: false }).pipe(
      Layer.provide(
        Layer.mergeAll(
          recordingLayer(memory, operations),
          Path.layer,
          AgentDirectory.layer("/agent"),
        ),
      ),
    );
    return Effect.gen(function* () {
      const store = yield* CodeModeConfigStore;
      const state = store.snapshot();
      // The project path is calculated as inert metadata only.
      expect(state.projectConfigPath).toBe(PROJECT_PATH);
      expect(state.projectValues).toEqual({});
      expect(state.config.timeoutMs).toBe(45_000);
      expect(state.available).toBe(false);

      // Global writes never read, stat, or write the project document either.
      yield* store.setSetting("global", "maxToolCalls", "8");
      const refused = yield* store.setSetting("project", "enabled", "true").pipe(Effect.flip);
      expect(refused._tag).toBe("CodeModeUntrustedScopeError");

      expect(operations.length).toBeGreaterThan(0);
      expect(operations.filter((operation) => operation.includes(PROJECT_PATH))).toEqual([]);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({ enabled: true, timeoutMs: 1_000 });
    }).pipe(Effect.scoped, provideBuiltLayer(layer));
  });
});
