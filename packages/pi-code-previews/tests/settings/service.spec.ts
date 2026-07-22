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
import {
  AgentDirectory,
  JsonDocumentError,
  JsonDocumentStore,
  type JsonDocumentModification,
  type JsonObject,
} from "pi-cosmic-core";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { CodePreviewEnvironmentService } from "../../src/settings/environment-service";
import { codePreviewSettings } from "../../src/settings/state";
import { CodePreviewSettingsService, settingsSaveContextProjection } from "../../src/settings/service";

function commitModification<A, E, R, AfterCommitR>(
  modify: (document: JsonObject) => Effect.Effect<JsonDocumentModification<A, AfterCommitR>, E, R>,
  document: JsonObject = {},
): Effect.Effect<A, E, R | AfterCommitR> {
  return modify(document).pipe(
    Effect.flatMap(({ value, afterCommit }) =>
      (afterCommit ?? Effect.void).pipe(Effect.as(value), Effect.uninterruptible),
    ),
  );
}

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
    modifyObject: (_path, modify) => commitModification(modify),
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
      modifyObject: (_path, modify) => commitModification(modify),
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
      modifyObject: (_path, modify) =>
        modify({}).pipe(
          Effect.andThen(
            Effect.fail(
              new JsonDocumentError({
                operation: "write",
                path: "/secret/settings.json",
                message: "expected failure",
              }),
            ),
          ),
        ),
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
        const saveContextBefore = settingsSaveContextProjection();
        const failed = yield* service.save({ ...before.settings, readCollapsedLines: 42 }).pipe(
          Effect.as(false),
          Effect.catch(() => Effect.succeed(true)),
        );
        assert.equal(failed, true);
        assert.equal((yield* service.snapshot).settings.readCollapsedLines, 17);
        assert.equal(codePreviewSettings, publishedBefore);
        assert.equal(codePreviewSettings.readCollapsedLines, 17);
        assert.equal(settingsSaveContextProjection(), saveContextBefore);
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("runtime-invalid settings fail before document commit or projection publication", () =>
  Effect.gen(function* () {
    let modifications = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync((): JsonObject | undefined => undefined),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) => {
        modifications++;
        return commitModification(modify);
      },
      updateObject: () => Effect.die("legacy updateObject must not be used"),
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
        const saveContextBefore = settingsSaveContextProjection();
        const invalid = { ...before.settings, tools: null } as unknown as typeof before.settings;
        const failure = yield* service.save(invalid).pipe(Effect.flip);
        assert.ok(failure instanceof JsonDocumentError);
        assert.equal(failure.operation, "validate");
        assert.equal(modifications, 0);
        assert.equal(yield* service.snapshot, before);
        assert.equal(codePreviewSettings, publishedBefore);
        assert.equal(settingsSaveContextProjection(), saveContextBefore);
      }),
    ).pipe(Effect.provide(layer));
  }),
);

it.effect("save fails typed without atomic document modification capability", () =>
  Effect.gen(function* () {
    let legacyUpdates = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync((): JsonObject | undefined => undefined),
      writeObject: () => Effect.void,
      updateObject: (_path, update) =>
        Effect.sync(() => {
          legacyUpdates++;
          return update({});
        }),
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
        const failure = yield* service
          .save({ ...before.settings, readCollapsedLines: 42 })
          .pipe(Effect.flip);
        assert.ok(failure instanceof JsonDocumentError);
        assert.equal(failure.operation, "write");
        assert.equal(legacyUpdates, 0);
        assert.equal((yield* service.snapshot).settings.readCollapsedLines, 17);
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
      modifyObject: (_path, modify) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(modify({})),
          Effect.flatMap(({ value, document, afterCommit }) =>
            Effect.sync(() => {
              persistedLines = document.readCollapsedLines;
            }).pipe(
              Effect.andThen(afterCommit ?? Effect.void),
              Effect.as(value),
              Effect.uninterruptible,
            ),
          ),
        ),
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

it.effect("interruption after JSON commit cannot leave authoritative settings stale", () =>
  Effect.gen(function* () {
    const committed = yield* Deferred.make<void>();
    const releaseAfterCommit = yield* Deferred.make<void>();
    let persistedDocument: JsonObject = {
      owner: "keep",
      codePreview: { futureSetting: { enabled: true }, readCollapsedLines: 17 },
    };
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync((): JsonObject | undefined => undefined),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) =>
        modify(persistedDocument).pipe(
          Effect.flatMap(({ value, document, afterCommit }) =>
            Effect.sync(() => {
              persistedDocument = document;
            }).pipe(
              Effect.andThen(Deferred.succeed(committed, undefined)),
              Effect.andThen(Deferred.await(releaseAfterCommit)),
              Effect.andThen(afterCommit ?? Effect.void),
              Effect.as(value),
              Effect.uninterruptible,
            ),
          ),
        ),
      updateObject: () => Effect.die("legacy updateObject must not be used"),
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
        yield* Deferred.await(committed);
        assert.deepEqual(persistedDocument, {
          owner: "keep",
          codePreview: { futureSetting: { enabled: true }, readCollapsedLines: 42 },
        });
        assert.equal((yield* service.snapshot).settings.readCollapsedLines, 17);
        assert.equal(codePreviewSettings.readCollapsedLines, 17);

        const interruptFiber = yield* Fiber.interrupt(saveFiber).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseAfterCommit, undefined);
        yield* Fiber.join(interruptFiber);

        const committedState = yield* service.snapshot;
        assert.deepEqual(committedState.saveContext.globalDocument, persistedDocument);
        assert.deepEqual(committedState.saveContext.globalOverrides, {
          futureSetting: { enabled: true },
          readCollapsedLines: 42,
        });
        assert.equal(committedState.saveContext.nested, true);
        assert.equal(committedState.saveContext.baseline.readCollapsedLines, 17);
        assert.equal(committedState.saveContext.loaded.readCollapsedLines, 42);
        assert.equal(committedState.settings.readCollapsedLines, 42);
        assert.equal(codePreviewSettings.readCollapsedLines, 42);
        assert.deepEqual(settingsSaveContextProjection(), committedState.saveContext);
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
      modifyObject: (_path, modify) => commitModification(modify),
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
