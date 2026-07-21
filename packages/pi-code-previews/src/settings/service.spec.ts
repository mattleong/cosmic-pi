// Effect-owned settings state and interruption assertions.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/strictEffectProvide:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import assert from "node:assert/strict";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { AgentDirectory, JsonDocumentError, JsonDocumentStore } from "pi-cosmic-core";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { CodePreviewEnvironmentService } from "./environment-service";
import { codePreviewSettings } from "./state";
import { CodePreviewSettingsService, settingsSaveContextProjection } from "./service";

it.effect("logs a sanitized warning and continues after a malformed settings document", () => {
  const captured = makeCapturedLogger();
  let reads = 0;
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(true),
    readObject: () => {
      reads++;
      return reads === 1
        ? Effect.fail(
            new JsonDocumentError({
              operation: "decode",
              path: "/secret/settings.json",
              message: "secret malformed payload",
            }),
          )
        : Effect.sync(() => undefined);
    },
    writeObject: () => Effect.void,
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  const dependencies = Layer.mergeAll(
    CodePreviewEnvironmentService.layerFrom({}),
    AgentDirectory.layer("/agent"),
    NodePath.layer,
    Layer.succeed(JsonDocumentStore, documents),
  );
  return CodePreviewSettingsService.use((service) => service.load()).pipe(
    Effect.provide(
      Layer.merge(
        CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies)),
        captured.layer,
      ),
    ),
    Effect.tap(() =>
      Effect.sync(() => {
        const telemetry = JSON.stringify(captured.entries);
        assert.match(telemetry, /Failed to load settings for code previews/);
        assert.equal(telemetry.includes("secret/settings"), false);
        assert.equal(telemetry.includes("secret malformed"), false);
      }),
    ),
  );
});

it.effect("starts each session from its own environment defaults", () =>
  Effect.gen(function* () {
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync(() => undefined),
      writeObject: () => Effect.void,
      updateObject: (_path, update) => Effect.sync(() => update({})),
    });
    const makeLayer = (readLines: string) => {
      const dependencies = Layer.mergeAll(
        CodePreviewEnvironmentService.layerFrom({ CODE_PREVIEW_READ_LINES: readLines }),
        AgentDirectory.layer("/agent"),
        NodePath.layer,
        Layer.succeed(JsonDocumentStore, documents),
      );
      return CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
    };
    const first = yield* CodePreviewSettingsService.use((service) => service.snapshot).pipe(
      Effect.provide(makeLayer("17")),
    );
    const second = yield* CodePreviewSettingsService.use((service) => service.snapshot).pipe(
      Effect.provide(makeLayer("29")),
    );
    assert.equal(first.settings.readCollapsedLines, 17);
    assert.equal(first.saveContext.baseline.readCollapsedLines, 17);
    assert.equal(second.settings.readCollapsedLines, 29);
    assert.equal(second.saveContext.baseline.readCollapsedLines, 29);
    assert.equal(Object.isFrozen(codePreviewSettings), true);
    assert.equal(Object.isFrozen(settingsSaveContextProjection()), true);
  }),
);

it.effect("failed persistence leaves authoritative state and renderer projection unchanged", () =>
  Effect.gen(function* () {
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync(() => undefined),
      writeObject: () => Effect.void,
      updateObject: () =>
        Effect.fail(
          new JsonDocumentError({
            operation: "write",
            path: "/secret/settings.json",
            message: "expected failure",
          }),
        ),
    });
    const dependencies = Layer.mergeAll(
      CodePreviewEnvironmentService.layerFrom({ CODE_PREVIEW_READ_LINES: "17" }),
      AgentDirectory.layer("/agent"),
      NodePath.layer,
      Layer.succeed(JsonDocumentStore, documents),
    );
    const layer = CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const before = yield* service.snapshot;
        const publishedBefore = codePreviewSettings;
        const failed = yield* service.save({ ...before.settings, readCollapsedLines: 42 }).pipe(
          Effect.as(false),
          Effect.catch(() => Effect.succeed(true)),
        );
        assert.equal(failed, true);
        assert.equal((yield* service.snapshot).settings.readCollapsedLines, 17);
        assert.equal(codePreviewSettings, publishedBefore);
        assert.equal(codePreviewSettings.readCollapsedLines, 17);
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("flush waits for prior saves and its interruption cannot lose the save", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let persistedLines: unknown;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync(() => undefined),
      writeObject: () => Effect.void,
      updateObject: (_path, update) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.map(() => {
            const document = update({});
            persistedLines = document.readCollapsedLines;
            return document;
          }),
        ),
    });
    const dependencies = Layer.mergeAll(
      CodePreviewEnvironmentService.layerFrom({ CODE_PREVIEW_READ_LINES: "17" }),
      AgentDirectory.layer("/agent"),
      NodePath.layer,
      Layer.succeed(JsonDocumentStore, documents),
    );
    const layer = CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const current = yield* service.snapshot;
        const saveFiber = yield* service
          .save({ ...current.settings, readCollapsedLines: 42 })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        let flushCompleted = false;
        const flushFiber = yield* service.flush.pipe(
          Effect.ensuring(Effect.sync(() => (flushCompleted = true))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        assert.equal(flushCompleted, false);
        yield* Fiber.interrupt(flushFiber);
        assert.equal(flushCompleted, true);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(saveFiber);
        assert.equal(persistedLines, 42);
        assert.equal((yield* service.snapshot).settings.readCollapsedLines, 42);
      }),
    ).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);

it.effect("interrupted settings loads finalize without publishing a partial snapshot", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let interrupted = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(true),
      readObject: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        ),
      writeObject: () => Effect.void,
      updateObject: (_path, update) => Effect.sync(() => update({})),
    });
    const dependencies = Layer.mergeAll(
      CodePreviewEnvironmentService.layerFrom({}),
      AgentDirectory.layer("/agent"),
      NodePath.layer,
      Layer.succeed(JsonDocumentStore, documents),
    );
    const layer = CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
    const fiber = yield* CodePreviewSettingsService.use((service) => service.load()).pipe(
      Effect.provide(layer),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    assert.equal(interrupted, 1);
  }).pipe(Effect.scoped),
);
