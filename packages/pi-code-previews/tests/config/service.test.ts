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
  type JsonDocumentStoreContract,
} from "pi-cosmic-core";
import { makeCapturedLogger, makeInMemoryDocuments } from "pi-cosmic-core/testing";
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
  const fake = makeInMemoryDocuments();
  let reads = 0;
  const documents = JsonDocumentStore.of({
    ...fake.service,
    readObject: (path) => {
      reads++;
      return reads === 1
        ? Effect.fail(
            new JsonDocumentError({
              operation: "decode",
              path: "/secret/settings.json",
              message: "secret malformed payload",
            }),
          )
        : fake.service.readObject(path);
    },
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
  const fake = makeInMemoryDocuments({
    "/agent/settings.json": {
      codePreview: {
        shikiTheme: "private-theme-token",
        readCollapsedLines: 21,
      },
    },
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
  ).pipe(provideBuiltLayer(Layer.merge(settingsLayer(fake.service), captured.layer)));
});

it.effect("a missing document loads session-local environment defaults", () => {
  const fake = makeInMemoryDocuments();
  const loadWith = (readLines: string) =>
    CodePreviewSettingsService.use((service) => loadSettings(service)).pipe(
      provideBuiltLayer(settingsLayer(fake.service, { CODE_PREVIEW_READ_LINES: readLines })),
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
  const fake = makeInMemoryDocuments();
  return Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 73 });
    yield* Layer.build(settingsLayer(fake.service, { CODE_PREVIEW_READ_LINES: "19" }));
    assert.equal(codePreviewSettings.readCollapsedLines, 73);
  }).pipe(Effect.scoped);
});

it.effect("settings operations serialize across separately built Layers", () =>
  Effect.gen(function* () {
    const firstReadStarted = yield* Deferred.make<void>();
    const releaseFirstRead = yield* Deferred.make<void>();
    const fake = makeInMemoryDocuments();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
      // Reads hold no document lock, so only the cross-Layer settings coordinator can block them.
      readObject: (path) =>
        Effect.suspend(() => {
          reads++;
          if (reads !== 1) return fake.service.readObject(path);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.andThen(fake.service.readObject(path)),
          );
        }),
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
    const fake = makeInMemoryDocuments({
      "/agent/settings.json": { codePreview: { readCollapsedLines: 31 } },
    });
    let reads = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
      readObject: (path) =>
        Effect.suspend(() => {
          reads++;
          if (reads !== 1) return fake.service.readObject(path);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.andThen(fake.service.readObject(path)),
          );
        }),
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
    const fake = makeInMemoryDocuments();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
      readObject: (path) =>
        Effect.suspend(() => {
          reads++;
          events.push(`read-${reads}`);
          if (reads !== 1) return fake.service.readObject(path);
          return Deferred.succeed(firstReadStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirstRead)),
            Effect.andThen(fake.service.readObject(path)),
          );
        }),
      modifyObject: (path, modify) =>
        fake.service
          .modifyObject(path, modify)
          .pipe(Effect.tap(() => Effect.sync(() => events.push("save")))),
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
    assert.equal(fake.documents.get("/agent/code-previews.json")?.readCollapsedLines, 42);
    assert.equal(codePreviewSettings.readCollapsedLines, 42);
  }).pipe(Effect.scoped),
);

it.effect("a stale save returns before document modification", () => {
  const fake = makeInMemoryDocuments();
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const stale = makeSettingsAdmission();
      yield* service.load(makeSettingsAdmission());
      const published = codePreviewSettings;
      yield* service.save({ ...defaultCodePreviewSettings, readCollapsedLines: 99 }, stale);
      assert.equal(fake.updateCount, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(fake.service)));
});

it.effect("flush in another Layer waits for one-shot rehydrate and save", () =>
  Effect.gen(function* () {
    const saveStarted = yield* Deferred.make<void>();
    const releaseSave = yield* Deferred.make<void>();
    let flushCompleted = false;
    const fake = makeInMemoryDocuments();
    fake.blockNextUpdateBeforeCommit(saveStarted, releaseSave);
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 17 });
    const save = yield* CodePreviewSettingsService.use((service) =>
      service.save(
        { ...defaultCodePreviewSettings, readCollapsedLines: 42 },
        makeSettingsAdmission(),
        { rehydrate: {} },
      ),
    ).pipe(provideBuiltLayer(settingsLayer(fake.service)), Effect.forkScoped);
    yield* Deferred.await(saveStarted);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);

    const flush = yield* CodePreviewSettingsService.use((service) => service.flush).pipe(
      provideBuiltLayer(settingsLayer(fake.service)),
      Effect.ensuring(Effect.sync(() => (flushCompleted = true))),
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    assert.equal(flushCompleted, false);
    yield* Deferred.succeed(releaseSave, undefined);
    yield* Fiber.join(save);
    yield* Fiber.join(flush);
    assert.equal(fake.documents.get("/agent/code-previews.json")?.readCollapsedLines, 42);
    assert.equal(codePreviewSettings.readCollapsedLines, 42);
  }).pipe(Effect.scoped),
);

it.effect("save persists the flat document and publishes the committed settings", () => {
  const fake = makeInMemoryDocuments({
    "/agent/code-previews.json": { owner: "keep", readCollapsedLines: 17 },
  });
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 });
      assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
        owner: "keep",
        readCollapsedLines: 42,
      });
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
      assert.equal(Object.isFrozen(codePreviewSettings), true);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(fake.service)));
});

it.effect("save preserves concurrently changed known fields that the caller did not edit", () => {
  const fake = makeInMemoryDocuments({
    "/agent/code-previews.json": {
      owner: "initial",
      shikiTheme: "github-dark",
      readCollapsedLines: 17,
    },
  });
  return CodePreviewSettingsService.use((service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      fake.documents.set("/agent/code-previews.json", {
        ...fake.documents.get("/agent/code-previews.json"),
        owner: "external",
        shikiTheme: "github-light",
      });

      yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 });

      assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
        owner: "external",
        shikiTheme: "github-light",
        readCollapsedLines: 42,
      });
    }),
  ).pipe(provideBuiltLayer(settingsLayer(fake.service)));
});

it.effect("failed persistence leaves the published settings unchanged", () => {
  const fake = makeInMemoryDocuments();
  const documents = JsonDocumentStore.of({
    ...fake.service,
    modifyObject: (path, modify) =>
      fake.service.modifyObject(path, (document) =>
        modify(document).pipe(
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
      ),
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
  const fake = makeInMemoryDocuments();
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
      assert.equal(fake.updateCount, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(fake.service)));
});

it.effect("save fails typed without atomic document modification capability", () => {
  const fake = makeInMemoryDocuments();
  const documents = JsonDocumentStore.of({
    exists: fake.service.exists,
    readObject: fake.service.readObject,
    writeObject: fake.service.writeObject,
    updateObject: fake.service.updateObject,
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
      assert.equal(fake.updateCount, 0);
      assert.equal(codePreviewSettings, published);
    }),
  ).pipe(provideBuiltLayer(settingsLayer(documents)));
});

it.effect("flush waits for an earlier save and interruption cannot lose that save", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fake = makeInMemoryDocuments();
    fake.blockNextUpdateBeforeCommit(started, release);
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
        assert.equal(fake.documents.get("/agent/code-previews.json")?.readCollapsedLines, 42);
        assert.equal(codePreviewSettings.readCollapsedLines, 42);
      }),
    ).pipe(provideBuiltLayer(settingsLayer(fake.service, { CODE_PREVIEW_READ_LINES: "17" })));
  }).pipe(Effect.scoped),
);

it.effect("post-rename publication completes before save interruption becomes visible", () =>
  Effect.gen(function* () {
    const renamed = yield* Deferred.make<void>();
    const releaseAfterRename = yield* Deferred.make<void>();
    const fake = makeInMemoryDocuments({
      "/agent/code-previews.json": {
        owner: "keep",
        futureSetting: { enabled: true },
        readCollapsedLines: 17,
      },
    });
    fake.blockNextUpdateAtCommit(renamed, releaseAfterRename);
    yield* CodePreviewSettingsService.use((service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        const saveFiber = yield* service
          .save({ ...loaded, readCollapsedLines: 42 }, makeSettingsAdmission())
          .pipe(Effect.forkScoped);
        yield* Deferred.await(renamed);
        assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
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
    ).pipe(provideBuiltLayer(settingsLayer(fake.service, { CODE_PREVIEW_READ_LINES: "17" })));
  }).pipe(Effect.scoped),
);

it.effect("interrupted loads do not publish a partial settings document", () =>
  Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 17 });
    const started = yield* Deferred.make<void>();
    const fake = makeInMemoryDocuments();
    let interrupted = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
      readObject: () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => interrupted++)),
        ),
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
