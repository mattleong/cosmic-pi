// Deterministic config-store suite: each test is a Layer entry point for the store runtime.
// @effect-diagnostics effect/strictEffectProvide:off
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory, JsonDocumentStore, type JsonDocumentStoreShape } from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import { normalizeConfig } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TERMINAL_CONFIG } from "../src/config/schema.ts";
import { BackgroundTerminalConfigStore } from "../src/config/store.ts";

const GLOBAL_PATH = "/agent/extensions/pi-background-terminals.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-background-terminals.json";

const recordingService = (
  memory: InMemoryDocuments,
  operations: string[],
): JsonDocumentStoreShape => ({
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

const storeLayer = (service: JsonDocumentStoreShape, projectTrusted: boolean) =>
  BackgroundTerminalConfigStore.layer({ cwd: "/project", projectTrusted }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(JsonDocumentStore, service),
        Path.layer,
        AgentDirectory.layer("/agent"),
      ),
    ),
  );

describe("background terminal config", () => {
  it("normalizes bounds and preserves independent valid fields", () => {
    const config = normalizeConfig({
      enabled: false,
      maxRunning: 0,
      maxRetained: 10_000,
      logBufferBytesPerJob: 8_192,
      totalLogBufferBytes: 1,
      stopGraceMs: -1,
      maxLogWaitSeconds: 999,
      shellPath: "  /bin/zsh  ",
    });
    expect(config.enabled).toBe(false);
    expect(config.maxRunning).toBe(1);
    expect(config.maxRetained).toBe(500);
    expect(config.totalLogBufferBytes).toBeGreaterThanOrEqual(config.logBufferBytesPerJob);
    expect(config.stopGraceMs).toBe(0);
    expect(config.maxLogWaitSeconds).toBe(120);
    expect(config.shellPath).toBe("/bin/zsh");
  });

  it("uses safe defaults", () => {
    expect(normalizeConfig()).toEqual(DEFAULT_BACKGROUND_TERMINAL_CONFIG);
  });
});

describe("background terminal config store", () => {
  it.effect("untrusted resolution performs no project-document I/O at all", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false, showFooterStatus: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    const operations: string[] = [];
    return Effect.gen(function* () {
      const config = yield* BackgroundTerminalConfigStore;
      // The untrusted project overlay never applies, and its document is never touched.
      expect(config.enabled).toBe(true);
      expect(config.showFooterStatus).toBe(DEFAULT_BACKGROUND_TERMINAL_CONFIG.showFooterStatus);
      expect(config.stopGraceMs).toBe(1_000);
      expect(operations.length).toBeGreaterThan(0);
      expect(operations.filter((operation) => operation.includes(PROJECT_PATH))).toEqual([]);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({
        enabled: false,
        showFooterStatus: false,
      });
    }).pipe(Effect.provide(storeLayer(recordingService(memory, operations), false)));
  });

  it.effect("trusted resolution still overlays the project document over the global one", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    const operations: string[] = [];
    return Effect.gen(function* () {
      const config = yield* BackgroundTerminalConfigStore;
      expect(config.enabled).toBe(false);
      expect(config.stopGraceMs).toBe(1_000);
      expect(operations.some((operation) => operation === `exists:${PROJECT_PATH}`)).toBe(true);
      expect(operations.some((operation) => operation === `read:${PROJECT_PATH}`)).toBe(true);
    }).pipe(Effect.provide(storeLayer(recordingService(memory, operations), true)));
  });
});
