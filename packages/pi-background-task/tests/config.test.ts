// Deterministic config-store suite: each test is a Layer entry point for the store runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { AgentDirectory, provideBuiltLayer } from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import { normalizeConfig } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import { BackgroundTaskConfigStore } from "../src/config/store.ts";

const GLOBAL_PATH = "/agent/extensions/pi-background-task.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-background-task.json";

const storeLayer = (memory: InMemoryDocuments, projectTrusted: boolean) =>
  BackgroundTaskConfigStore.layer({ cwd: "/project", projectTrusted }).pipe(
    Layer.provide(Layer.mergeAll(memory.layer, Path.layer, AgentDirectory.layer("/agent"))),
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
      maxWaitSeconds: 999,
      shellPath: "  /bin/zsh  ",
    });
    expect(config.enabled).toBe(false);
    expect(config.maxRunning).toBe(1);
    expect(config.maxRetained).toBe(500);
    expect(config.totalLogBufferBytes).toBeGreaterThanOrEqual(config.logBufferBytesPerTask);
    expect(config.stopGraceMs).toBe(0);
    expect(config.maxWaitSeconds).toBe(120);
    expect(config.shellPath).toBe("/bin/zsh");
  });
});

describe("background task config store", () => {
  it.effect("untrusted resolution performs no project-document I/O at all", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false, showFooterStatus: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    return Effect.gen(function* () {
      const config = yield* BackgroundTaskConfigStore;
      // The untrusted project overlay never applies, and its document is never touched.
      expect(config.enabled).toBe(true);
      expect(config.showFooterStatus).toBe(DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus);
      expect(config.stopGraceMs).toBe(1_000);
      expect(memory.operations.length).toBeGreaterThan(0);
      expect(memory.operations.filter((operation) => operation.includes(PROJECT_PATH))).toEqual([]);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({
        enabled: false,
        showFooterStatus: false,
      });
    }).pipe(provideBuiltLayer(storeLayer(memory, false)));
  });

  it.effect("trusted resolution still overlays the project document over the global one", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    return Effect.gen(function* () {
      const config = yield* BackgroundTaskConfigStore;
      expect(config.enabled).toBe(false);
      expect(config.stopGraceMs).toBe(1_000);
      expect(memory.operations).toContain(`exists:${PROJECT_PATH}`);
      expect(memory.operations).toContain(`read:${PROJECT_PATH}`);
    }).pipe(provideBuiltLayer(storeLayer(memory, true)));
  });
});
