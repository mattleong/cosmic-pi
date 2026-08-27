// Deterministic config-store suite: each test is a Layer entry point for the store runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import {
  AgentDirectory,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonDocumentStoreContract,
} from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import { normalizeConfig } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";

const GLOBAL_PATH = "/agent/extensions/pi-background-task.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-background-task.json";

const recordingService = (
  memory: InMemoryDocuments,
  operations: string[],
): JsonDocumentStoreContract => ({
  exists: (path) => {
    operations.push(`exists:${path}`);
    return memory.service.exists(path);
  },
  readObject: (path) => {
    operations.push(`read:${path}`);
    return memory.service.readObject(path);
  },
  writeObject: (path, document) => {
    operations.push(`write:${path}`);
    return memory.service.writeObject(path, document);
  },
  modifyObject: (path, modify) => {
    operations.push(`modify:${path}`);
    return memory.service.modifyObject(path, modify);
  },
  updateObject: (path, update) => {
    operations.push(`update:${path}`);
    return memory.service.updateObject(path, update);
  },
});

const storeLayer = (service: JsonDocumentStoreContract, projectTrusted: boolean) =>
  BackgroundTaskConfigStore.layer({ cwd: "/project", projectTrusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(JsonDocumentStore, service),
        Path.layer,
        AgentDirectory.layer("/agent"),
      ),
    ),
  );

describe("background task config", () => {
  it("normalizes bounds and preserves independent valid fields", () => {
    const config = normalizeConfig({
      enabled: false,
      maxRunning: 0,
      maxRetained: 10_000,
      logBufferBytesPerTask: 8_192,
      totalLogBufferBytes: 1,
      stopGraceMs: -1,
      maxLogWaitSeconds: 999,
      shellPath: "  /bin/zsh  ",
    });
    expect(config.enabled).toBe(false);
    expect(config.maxRunning).toBe(1);
    expect(config.maxRetained).toBe(500);
    expect(config.totalLogBufferBytes).toBeGreaterThanOrEqual(config.logBufferBytesPerTask);
    expect(config.stopGraceMs).toBe(0);
    expect(config.maxLogWaitSeconds).toBe(120);
    expect(config.shellPath).toBe("/bin/zsh");
  });

  it("uses safe defaults", () => {
    expect(normalizeConfig()).toEqual(DEFAULT_BACKGROUND_TASK_CONFIG);
  });
});

describe("background task config store", () => {
  it.effect("untrusted resolution performs no project-document I/O at all", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false, showFooterStatus: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    const operations: string[] = [];
    return Effect.gen(function* () {
      const config = yield* BackgroundTaskConfigStore;
      // The untrusted project overlay never applies, and its document is never touched.
      expect(config.enabled).toBe(true);
      expect(config.showFooterStatus).toBe(DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus);
      expect(config.stopGraceMs).toBe(1_000);
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.filter((operation) => operation.includes(PROJECT_PATH))).toEqual([]);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({
        enabled: false,
        showFooterStatus: false,
      });
    }).pipe(provideBuiltLayer(storeLayer(recordingService(memory, operations), false)));
  });

  it.effect("trusted resolution still overlays the project document over the global one", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    const operations: string[] = [];
    return Effect.gen(function* () {
      const config = yield* BackgroundTaskConfigStore;
      expect(config.enabled).toBe(false);
      expect(config.stopGraceMs).toBe(1_000);
      expect(operations.some((operation) => operation === `exists:${PROJECT_PATH}`)).toBe(true);
      expect(operations.some((operation) => operation === `read:${PROJECT_PATH}`)).toBe(true);
    }).pipe(provideBuiltLayer(storeLayer(recordingService(memory, operations), true)));
  });
});
