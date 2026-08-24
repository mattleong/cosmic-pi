// Effect-owned settings persistence and interruption assertions.
import assert from "node:assert/strict";
import * as NodePath from "@effect/platform-node/NodePath";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import {
  AgentDirectory,
  JsonDocumentError,
  JsonDocumentStore,
  provideBuiltLayer,
  type JsonDocumentModification,
  type JsonDocumentStoreContract,
  type JsonObject,
} from "pi-cosmic-core";
import { makeCapturedLogger } from "pi-cosmic-core/testing";
import { makeSettingsAdmission } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { CodePreviewEnvironmentService } from "../../src/config/env";
import type { CodePreviewSettings } from "../../src/config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import {
  CodePreviewSettingsService,
  type CodePreviewSettingsServiceContract,
} from "../../src/config/store";

const loadSettings = (service: CodePreviewSettingsServiceContract) =>
  service.load(makeSettingsAdmission());
const saveSettings = (service: CodePreviewSettingsServiceContract, settings: CodePreviewSettings) =>
  service.save(settings, makeSettingsAdmission());

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

function settingsLayer(
  documents: JsonDocumentStoreContract,
  environment: Readonly<Record<string, string>> = {},
) {
  const dependencies = Layer.mergeAll(
    CodePreviewEnvironmentService.layerFrom(environment),
    AgentDirectory.layer("/agent"),
    NodePath.layer,
    Layer.succeed(JsonDocumentStore, documents),
  );
  return CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
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
        : Effect.sync((): JsonObject | undefined => undefined);
    },
    writeObject: () => Effect.void,
    modifyObject: (_path, modify) => commitModification(modify),
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  return CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
    provideBuiltLayer(Layer.merge(settingsLayer(documents), captured.layer)),
    Effect.tap((loaded) =>
      Effect.sync(() => {
        assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
        const telemetry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
          captured.entries,
        );
        assert.match(telemetry, /Failed to load settings for code previews/);
        assert.equal(telemetry.includes("secret/settings"), false);
        assert.equal(telemetry.includes("secret malformed"), false);
      }),
    ),
  );
});

it.effect("load returns mutable defensive clones and publishes frozen loaded settings", () => {
  const captured = makeCapturedLogger();
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(true),
    readObject: (path) =>
      Effect.succeed(
        path === "/agent/settings.json"
          ? {
              codePreview: {
                shikiTheme: "private-theme-token",
                readCollapsedLines: 21,
              },
            }
          : undefined,
      ),
    writeObject: () => Effect.void,
    modifyObject: (_path, modify) => commitModification(modify),
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const first = yield* loadSettings(service);
      assert.equal(first.readCollapsedLines, 21);
      assert.notEqual(first, codePreviewSettings);
      assert.notEqual(first.tools, codePreviewSettings.tools);
      first.readCollapsedLines = 99;
      first.tools.length = 0;
      assert.equal(codePreviewSettings.readCollapsedLines, 21);
      assert.deepEqual(codePreviewSettings.tools, defaultCodePreviewSettings.tools);
      assert.equal(Object.isFrozen(codePreviewSettings), true);
      assert.equal(Object.isFrozen(codePreviewSettings.tools), true);

      const second = yield* loadSettings(service);
      assert.notEqual(second, first);
      assert.notEqual(second.tools, first.tools);
      assert.equal(second.readCollapsedLines, 21);
      assert.deepEqual(second.tools, defaultCodePreviewSettings.tools);
      const telemetry = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(captured.entries);
      assert.match(telemetry, /settings\.shikiTheme/);
      assert.equal(telemetry.includes("private-theme-token"), false);
      assert.equal(telemetry.includes("/agent"), false);
    }),
  ).pipe(provideBuiltLayer(Layer.merge(settingsLayer(documents), captured.layer)));
});

it.effect("a missing document loads session-local environment defaults", () => {
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(false),
    readObject: () => Effect.sync((): JsonObject | undefined => undefined),
    writeObject: () => Effect.void,
    modifyObject: (_path, modify) => commitModification(modify),
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  const loadWith = (readLines: string) =>
    CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
      provideBuiltLayer(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: readLines })),
    );
  return Effect.gen(function* () {
    const first = yield* loadWith("17");
    const second = yield* loadWith("29");
    assert.equal(first.readCollapsedLines, 17);
    assert.equal(second.readCollapsedLines, 29);
    assert.notEqual(first, second);
    assert.notEqual(first.tools, second.tools);
  });
});

it.effect("building the settings Layer does not publish its defaults", () => {
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(false),
    readObject: () => Effect.sync((): JsonObject | undefined => undefined),
    writeObject: () => Effect.void,
    modifyObject: (_path, modify) => commitModification(modify),
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  return Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 73 });
    yield* Layer.build(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: "19" }));
    assert.equal(codePreviewSettings.readCollapsedLines, 73);
  }).pipe(Effect.scoped);
});

it.effect("settings operations serialize across separately built Layers", () =>
  Effect.gen(function* () {
    const firstReadStarted = yield* Deferred.make<void>();
    const releaseFirstRead = yield* Deferred.make<void>();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () =>
        Effect.suspend(() => {
          reads++;
          if (reads !== 1) return Effect.sync((): JsonObject | undefined => undefined);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.as(undefined),
          );
        }),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) => commitModification(modify),
      updateObject: (_path, update) => Effect.sync(() => update({})),
    });
    const first = yield* CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
      provideBuiltLayer(settingsLayer(documents)),
      Effect.forkScoped,
    );
    yield* Deferred.await(firstReadStarted);
    const second = yield* CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
      provideBuiltLayer(settingsLayer(documents)),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    assert.equal(reads, 1);

    yield* Deferred.succeed(releaseFirstRead, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(reads, 4);
  }).pipe(Effect.scoped),
);

it.effect("a cancelled newer load does not suppress an older successful publication", () =>
  Effect.gen(function* () {
    const firstReadStarted = yield* Deferred.make<void>();
    const releaseFirstRead = yield* Deferred.make<void>();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(true),
      readObject: (path) =>
        Effect.suspend(() => {
          reads++;
          const result =
            path === "/agent/settings.json"
              ? { codePreview: { readCollapsedLines: 31 } }
              : undefined;
          if (reads !== 1) return Effect.succeed(result);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.as(result),
          );
        }),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) => commitModification(modify),
      updateObject: (_path, update) => Effect.sync(() => update({})),
    });
    const olderAdmission = makeSettingsAdmission();
    const newerAdmission = makeSettingsAdmission();
    const older = yield* CodePreviewSettingsService.use((service) =>
      service.load(olderAdmission),
    ).pipe(provideBuiltLayer(settingsLayer(documents)), Effect.forkScoped);
    yield* Deferred.await(firstReadStarted);
    const newer = yield* CodePreviewSettingsService.use((service) =>
      service.load(newerAdmission),
    ).pipe(provideBuiltLayer(settingsLayer(documents)), Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.equal(reads, 1);
    yield* Fiber.interrupt(newer);

    yield* Deferred.succeed(releaseFirstRead, undefined);
    yield* Fiber.join(older);
    assert.equal(reads, 2);
    assert.equal(codePreviewSettings.readCollapsedLines, 31);
  }).pipe(Effect.scoped),
);

it.effect("a later save waits for an earlier load and publishes after it", () =>
  Effect.gen(function* () {
    const firstReadStarted = yield* Deferred.make<void>();
    const releaseFirstRead = yield* Deferred.make<void>();
    const events: string[] = [];
    let persisted: JsonObject = {};
    let reads = 0;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () =>
        Effect.suspend(() => {
          reads++;
          events.push(`read-${reads}`);
          if (reads !== 1) return Effect.sync((): JsonObject | undefined => undefined);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.as(undefined),
          );
        }),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) =>
        modify(persisted).pipe(
          Effect.flatMap(({ value, document, afterCommit }) =>
            Effect.sync(() => {
              events.push("save");
              persisted = document;
            }).pipe(
              Effect.andThen(afterCommit ?? Effect.void),
              Effect.as(value),
              Effect.uninterruptible,
            ),
          ),
        ),
      updateObject: () => Effect.die("legacy updateObject must not be used"),
    });
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const load = yield* service.load(makeSettingsAdmission()).pipe(Effect.forkScoped);
        yield* Deferred.await(firstReadStarted);
        const save = yield* service
          .save({ ...defaultCodePreviewSettings, readCollapsedLines: 42 }, makeSettingsAdmission())
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.deepEqual(events, ["read-1"]);
        yield* Deferred.succeed(releaseFirstRead, undefined);
        yield* Fiber.join(load);
        yield* Fiber.join(save);
      }),
    ).pipe(provideBuiltLayer(settingsLayer(documents)));

    assert.deepEqual(events, ["read-1", "read-2", "save"]);
    assert.equal(persisted.readCollapsedLines, 42);
    assert.equal(codePreviewSettings.readCollapsedLines, 42);
  }).pipe(Effect.scoped),
);

it.effect("a stale save returns before document modification", () => {
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
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const stale = makeSettingsAdmission();
      yield* service.load(makeSettingsAdmission());
      const published = codePreviewSettings;
      yield* service.save({ ...defaultCodePreviewSettings, readCollapsedLines: 99 }, stale);
      assert.equal(modifications, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents)));
});

it.effect("flush in another Layer waits for one-shot rehydrate and save", () =>
  Effect.gen(function* () {
    const saveStarted = yield* Deferred.make<void>();
    const releaseSave = yield* Deferred.make<void>();
    let flushCompleted = false;
    let persisted: JsonObject = {};
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync((): JsonObject | undefined => undefined),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) =>
        Deferred.succeed(saveStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSave)),
          Effect.andThen(modify(persisted)),
          Effect.flatMap(({ value, document, afterCommit }) =>
            Effect.sync(() => {
              persisted = document;
            }).pipe(
              Effect.andThen(afterCommit ?? Effect.void),
              Effect.as(value),
              Effect.uninterruptible,
            ),
          ),
        ),
      updateObject: () => Effect.die("legacy updateObject must not be used"),
    });
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 17 });
    const save = yield* CodePreviewSettingsService.use((service) =>
      service.save(
        { ...defaultCodePreviewSettings, readCollapsedLines: 42 },
        makeSettingsAdmission(),
        { rehydrate: {} },
      ),
    ).pipe(provideBuiltLayer(settingsLayer(documents)), Effect.forkScoped);
    yield* Deferred.await(saveStarted);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);

    const flush = yield* CodePreviewSettingsService.use((service) => service.flush).pipe(
      provideBuiltLayer(settingsLayer(documents)),
      Effect.ensuring(Effect.sync(() => (flushCompleted = true))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    assert.equal(flushCompleted, false);
    yield* Deferred.succeed(releaseSave, undefined);
    yield* Fiber.join(save);
    yield* Fiber.join(flush);
    assert.equal(persisted.readCollapsedLines, 42);
    assert.equal(codePreviewSettings.readCollapsedLines, 42);
  }).pipe(Effect.scoped),
);

it.effect("save persists the flat document and publishes the committed settings", () => {
  let persisted: JsonObject = { owner: "keep", readCollapsedLines: 17 };
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(true),
    readObject: (path) =>
      Effect.succeed(path === "/agent/code-previews.json" ? persisted : undefined),
    writeObject: () => Effect.void,
    modifyObject: (_path, modify) =>
      modify(persisted).pipe(
        Effect.flatMap(({ value, document, afterCommit }) =>
          Effect.sync(() => {
            persisted = document;
          }).pipe(
            Effect.andThen(afterCommit ?? Effect.void),
            Effect.as(value),
            Effect.uninterruptible,
          ),
        ),
      ),
    updateObject: () => Effect.die("legacy updateObject must not be used"),
  });
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 });
      assert.deepEqual(persisted, { owner: "keep", readCollapsedLines: 42 });
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
      assert.equal(Object.isFrozen(codePreviewSettings), true);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents)));
});

it.effect("failed persistence leaves the published settings unchanged", () => {
  const documents = JsonDocumentStore.of({
    exists: () => Effect.succeed(false),
    readObject: () => Effect.sync((): JsonObject | undefined => undefined),
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
    updateObject: () => Effect.die("legacy updateObject must not be used"),
  });
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      const published = codePreviewSettings;
      const failure = yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 }).pipe(
        Effect.flip,
      );
      assert.ok(failure instanceof JsonDocumentError);
      assert.equal(codePreviewSettings, published);
      assert.equal(codePreviewSettings.readCollapsedLines, loaded.readCollapsedLines);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: "17" })));
});

it.effect("runtime-invalid settings fail before document modification or publication", () => {
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
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      const published = codePreviewSettings;
      const invalidFixture = { ...loaded, tools: null };
      // SAFETY: This deliberately malformed fixture exercises save-time schema validation.
      const invalid = invalidFixture as typeof invalidFixture & typeof loaded;
      const failure = yield* saveSettings(service, invalid).pipe(Effect.flip);
      assert.ok(failure instanceof JsonDocumentError);
      assert.equal(failure.operation, "validate");
      assert.equal(modifications, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents)));
});

it.effect("save fails typed without atomic document modification capability", () => {
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
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      const published = codePreviewSettings;
      const failure = yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 }).pipe(
        Effect.flip,
      );
      assert.ok(failure instanceof JsonDocumentError);
      assert.equal(failure.operation, "write");
      assert.equal(legacyUpdates, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents)));
});

it.effect("flush waits for an earlier save and interruption cannot lose that save", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let persistedLines: unknown;
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(false),
      readObject: () => Effect.sync((): JsonObject | undefined => undefined),
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
      updateObject: () => Effect.die("legacy updateObject must not be used"),
    });
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        const saveFiber = yield* service
          .save({ ...loaded, readCollapsedLines: 42 }, makeSettingsAdmission())
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
        assert.equal(codePreviewSettings.readCollapsedLines, 42);
      }),
    ).pipe(provideBuiltLayer(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: "17" })));
  }).pipe(Effect.scoped),
);

it.effect("post-rename publication completes before save interruption becomes visible", () =>
  Effect.gen(function* () {
    const renamed = yield* Deferred.make<void>();
    const releaseAfterRename = yield* Deferred.make<void>();
    let persisted: JsonObject = {
      owner: "keep",
      futureSetting: { enabled: true },
      readCollapsedLines: 17,
    };
    const documents = JsonDocumentStore.of({
      exists: () => Effect.succeed(true),
      readObject: (path) =>
        Effect.succeed(path === "/agent/code-previews.json" ? persisted : undefined),
      writeObject: () => Effect.void,
      modifyObject: (_path, modify) =>
        modify(persisted).pipe(
          Effect.flatMap(({ value, document, afterCommit }) =>
            Effect.sync(() => {
              persisted = document;
            }).pipe(
              Effect.andThen(Deferred.succeed(renamed, undefined)),
              Effect.andThen(Deferred.await(releaseAfterRename)),
              Effect.andThen(afterCommit ?? Effect.void),
              Effect.as(value),
              Effect.uninterruptible,
            ),
          ),
        ),
      updateObject: () => Effect.die("legacy updateObject must not be used"),
    });
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        const saveFiber = yield* service
          .save({ ...loaded, readCollapsedLines: 42 }, makeSettingsAdmission())
          .pipe(Effect.forkScoped);
        yield* Deferred.await(renamed);
        assert.deepEqual(persisted, {
          owner: "keep",
          futureSetting: { enabled: true },
          readCollapsedLines: 42,
        });
        assert.equal(codePreviewSettings.readCollapsedLines, 17);

        const interruptFiber = yield* Fiber.interrupt(saveFiber).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseAfterRename, undefined);
        yield* Fiber.join(interruptFiber);

        assert.equal(codePreviewSettings.readCollapsedLines, 42);
        assert.equal(Object.isFrozen(codePreviewSettings), true);
      }),
    ).pipe(provideBuiltLayer(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: "17" })));
  }).pipe(Effect.scoped),
);

it.effect("interrupted loads do not publish a partial settings document", () =>
  Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 17 });
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
    const fiber = yield* CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
      provideBuiltLayer(settingsLayer(documents, { CODE_PREVIEW_READ_LINES: "17" })),
      Effect.forkScoped,
    );
    yield* Deferred.await(started);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);
    yield* Fiber.interrupt(fiber);
    assert.equal(interrupted, 1);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);
  }).pipe(Effect.scoped),
);
