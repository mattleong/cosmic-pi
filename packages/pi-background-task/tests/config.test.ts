import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Str from "effect/String";
import { AgentDirectory } from "pi-cosmic-core";
import {
  makeInMemoryDocuments,
  type InMemoryDocuments,
  provideBuiltLayer,
} from "pi-cosmic-core/testing";
import { normalizeConfig } from "../src/config/options.ts";
import { DEFAULT_BACKGROUND_TASK_CONFIG } from "../src/config/schema.ts";
import {
  BackgroundTaskConfigStore,
  BackgroundTaskSettingsFiles,
  type BackgroundTaskSettingsLocation,
} from "../src/config/store.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "../src/task/bounds.ts";

const GLOBAL_PATH = "/agent/extensions/pi-background-task.json";
const PROJECT_PATH = "/project/.pi/extensions/pi-background-task.json";
const GLOBAL: BackgroundTaskSettingsLocation = { cwd: "/project", scope: "global" };
const PROJECT: BackgroundTaskSettingsLocation = { cwd: "/project", scope: "project" };

// The same composition the session layer uses, over in-memory documents.
const inMemoryConfigLayer = (memory: InMemoryDocuments, projectTrusted: boolean) =>
  Layer.merge(
    BackgroundTaskConfigStore.layer({ cwd: "/project", projectTrusted }),
    BackgroundTaskSettingsFiles.layer,
  ).pipe(Layer.provide(Layer.mergeAll(memory.layer, Path.layer, AgentDirectory.layer("/agent"))));

/** The configuration a new session would resolve from the documents. */
const sessionConfig = (memory: InMemoryDocuments, projectTrusted: boolean) =>
  BackgroundTaskConfigStore.use(Effect.succeed).pipe(
    provideBuiltLayer(inMemoryConfigLayer(memory, projectTrusted)),
  );

const settingsFiles = (memory: InMemoryDocuments) =>
  BackgroundTaskSettingsFiles.use(Effect.succeed).pipe(
    provideBuiltLayer(inMemoryConfigLayer(memory, true)),
  );

describe("background task config store", () => {
  it.effect("untrusted resolution performs no project-document I/O at all", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false, showFooterStatus: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    return Effect.gen(function* () {
      const config = yield* sessionConfig(memory, false);
      expect(config.enabled).toBe(true);
      expect(config.showFooterStatus).toBe(DEFAULT_BACKGROUND_TASK_CONFIG.showFooterStatus);
      expect(config.stopGraceMs).toBe(1_000);
      expect(memory.operations.length).toBeGreaterThan(0);
      expect(
        Arr.filter(memory.operations, (operation) =>
          Fn.pipe(operation, Str.includes(PROJECT_PATH)),
        ),
      ).toEqual([]);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({
        enabled: false,
        showFooterStatus: false,
      });
    });
  });

  it.effect("trusted resolution still overlays the project document over the global one", () => {
    const memory = makeInMemoryDocuments({
      [PROJECT_PATH]: { enabled: false },
      [GLOBAL_PATH]: { stopGraceMs: 1_000 },
    });
    return Effect.gen(function* () {
      const config = yield* sessionConfig(memory, true);
      expect(config.enabled).toBe(false);
      expect(config.stopGraceMs).toBe(1_000);
      expect(memory.operations).toContain(`exists:${PROJECT_PATH}`);
      expect(memory.operations).toContain(`read:${PROJECT_PATH}`);
    });
  });

  it.effect("a disabled global document disables the resolved configuration", () =>
    Effect.gen(function* () {
      const disabled = makeInMemoryDocuments({ [GLOBAL_PATH]: { enabled: false } });
      expect((yield* sessionConfig(disabled, false)).enabled).toBe(false);
      expect((yield* sessionConfig(makeInMemoryDocuments(), false)).enabled).toBe(true);
    }),
  );

  it.effect("drops wrong-typed fields individually and keeps the valid ones", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: {
        enabled: "false",
        maxRunning: "16",
        showFooterStatus: null,
        shellPath: 7,
        stopGraceMs: 1_000,
        maxWaitSeconds: 45,
      },
    });
    return Effect.gen(function* () {
      const config = yield* sessionConfig(memory, false);
      expect(config).toEqual({
        ...DEFAULT_BACKGROUND_TASK_CONFIG,
        stopGraceMs: 1_000,
        maxWaitSeconds: 45,
      });
      const files = yield* settingsFiles(memory);
      expect(yield* files.read(GLOBAL)).toEqual({ stopGraceMs: 1_000, maxWaitSeconds: 45 });
    });
  });

  it.effect("clamps values into bounds and raises the total to one task's output", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: {
        maxRunning: 1_000,
        maxRetained: 0,
        logBufferBytesPerTask: 1_048_576,
        totalLogBufferBytes: 4_096,
        stopGraceMs: -5,
        maxWaitSeconds: 10_000,
        shellPath: "  /bin/zsh  ",
      },
      [PROJECT_PATH]: { maxRetained: 2.9 },
    });
    return Effect.gen(function* () {
      const config = yield* sessionConfig(memory, true);
      expect(config).toEqual({
        ...DEFAULT_BACKGROUND_TASK_CONFIG,
        maxRunning: 64,
        maxRetained: 2,
        logBufferBytesPerTask: 1_048_576,
        totalLogBufferBytes: 1_048_576,
        stopGraceMs: 0,
        maxWaitSeconds: BACKGROUND_TASK_FIELD_BOUNDS.maxWaitSeconds,
        shellPath: "/bin/zsh",
      });
      expect(normalizeConfig({ shellPath: " \t " })).not.toHaveProperty("shellPath");
    });
  });

  it.effect("writes one field per scope, and inherit removes only that scope's value", () => {
    const memory = makeInMemoryDocuments({
      [GLOBAL_PATH]: { maxRunning: 4, stopGraceMs: 1_000, unrelated: { kept: true } },
      [PROJECT_PATH]: { maxRunning: 2 },
    });
    return Effect.gen(function* () {
      const files = yield* settingsFiles(memory);
      yield* files.write(GLOBAL, "maxWaitSeconds", 60);
      yield* files.write(GLOBAL, "maxRunning", undefined);
      yield* files.write(PROJECT, "showFooterStatus", false);
      expect(memory.documents.get(GLOBAL_PATH)).toEqual({
        stopGraceMs: 1_000,
        unrelated: { kept: true },
        maxWaitSeconds: 60,
      });
      expect(memory.documents.get(PROJECT_PATH)).toEqual({
        maxRunning: 2,
        showFooterStatus: false,
      });
      expect(yield* sessionConfig(memory, true)).toMatchObject({
        maxRunning: 2,
        stopGraceMs: 1_000,
        maxWaitSeconds: 60,
        showFooterStatus: false,
      });

      yield* files.write(PROJECT, "maxRunning", undefined);
      expect(memory.documents.get(PROJECT_PATH)).toEqual({ showFooterStatus: false });
      expect((yield* sessionConfig(memory, true)).maxRunning).toBe(
        DEFAULT_BACKGROUND_TASK_CONFIG.maxRunning,
      );
    });
  });
});
