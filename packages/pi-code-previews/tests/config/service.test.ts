// Effect-owned settings persistence and interruption assertions.
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
  provideBuiltLayer,
  type JsonDocumentStoreContract,
  type JsonValue,
} from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeInMemoryDocuments,
  type InMemoryDocuments,
} from "pi-cosmic-core/testing";
import { makeSettingsAdmission } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import {
  codePreviewSettings,
  codePreviewSettingsProblems,
  setCodePreviewSettings,
} from "../../src/config/state";
import {
  CodePreviewSettingsService,
  type CodePreviewSettingsServiceContract,
} from "../../src/config/store";

const loadSettings = (service: CodePreviewSettingsServiceContract) =>
  service.load(makeSettingsAdmission());
const saveSettings = (service: CodePreviewSettingsServiceContract, settings: CodePreviewSettings) =>
  service.save(settings, makeSettingsAdmission());

function settingsLayer(documents: JsonDocumentStoreContract) {
  const dependencies = Layer.mergeAll(
    AgentDirectory.layer("/agent"),
    NodePath.layer,
    Layer.succeed(JsonDocumentStore, documents),
  );
  return CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
}

/** Runs `use` against a settings service built over `documents`. */
const usingSettings = <A, E, R>(
  documents: JsonDocumentStoreContract,
  use: (service: CodePreviewSettingsServiceContract) => Effect.Effect<A, E, R>,
) => CodePreviewSettingsService.use(use).pipe(provideBuiltLayer(settingsLayer(documents)));

/** Holds the first document read until `release` completes; later reads pass through. */
const gateFirstRead = (fake: InMemoryDocuments, onRead: (read: number) => void = () => undefined) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
      // Reads hold no document lock, so only the cross-Layer settings coordinator can block them.
      readObject: (path) =>
        Effect.suspend(() => {
          onRead(++reads);
          if (reads !== 1) return fake.service.readObject(path);
          return Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(fake.service.readObject(path)),
          );
        }),
    });
    return { documents, started, release, reads: () => reads };
  });

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
        const telemetry = capturedTelemetrySnapshot(captured);
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
      const telemetry = capturedTelemetrySnapshot(captured);
      assert.match(telemetry, /settings\.shikiTheme/);
      assert.equal(telemetry.includes("private-theme-token"), false);
      assert.equal(telemetry.includes("/agent"), false);
    }),
  ).pipe(provideBuiltLayer(Layer.merge(settingsLayer(fake.service), captured.layer)));
});

it.effect("building the settings Layer does not publish its defaults", () => {
  const fake = makeInMemoryDocuments();
  return Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 73 });
    yield* Layer.build(settingsLayer(fake.service));
    assert.equal(codePreviewSettings.readCollapsedLines, 73);
  }).pipe(Effect.scoped);
});

it.effect("settings operations serialize across separately built Layers", () =>
  Effect.gen(function* () {
    const gate = yield* gateFirstRead(makeInMemoryDocuments());
    const first = yield* usingSettings(gate.documents, loadSettings).pipe(Effect.forkScoped);
    yield* Deferred.await(gate.started);
    const second = yield* usingSettings(gate.documents, loadSettings).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.equal(gate.reads(), 1);

    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(gate.reads(), 4);
  }).pipe(Effect.scoped),
);

it.effect("a cancelled newer load does not suppress an older successful publication", () =>
  Effect.gen(function* () {
    const gate = yield* gateFirstRead(
      makeInMemoryDocuments({
        "/agent/settings.json": { codePreview: { readCollapsedLines: 31 } },
      }),
    );
    const olderAdmission = makeSettingsAdmission();
    const newerAdmission = makeSettingsAdmission();
    const older = yield* usingSettings(gate.documents, (service) =>
      service.load(olderAdmission),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(gate.started);
    const newer = yield* usingSettings(gate.documents, (service) =>
      service.load(newerAdmission),
    ).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.equal(gate.reads(), 1);
    yield* Fiber.interrupt(newer);

    yield* Deferred.succeed(gate.release, undefined);
    yield* Fiber.join(older);
    assert.equal(gate.reads(), 2);
    assert.equal(codePreviewSettings.readCollapsedLines, 31);
  }).pipe(Effect.scoped),
);

it.effect("a later save waits for an earlier load and publishes after it", () =>
  Effect.gen(function* () {
    const events: string[] = [];
    const fake = makeInMemoryDocuments();
    const gate = yield* gateFirstRead(fake, (read) => events.push(`read-${read}`));
    const documents = JsonDocumentStore.of({
      ...gate.documents,
      modifyObject: (path, modify) =>
        fake.service
          .modifyObject(path, modify)
          .pipe(Effect.tap(() => Effect.sync(() => events.push("save")))),
    });
    yield* usingSettings(documents, (service) =>
      Effect.gen(function* () {
        const load = yield* service.load(makeSettingsAdmission()).pipe(Effect.forkScoped);
        yield* Deferred.await(gate.started);
        const save = yield* service
          .save({ ...defaultCodePreviewSettings, readCollapsedLines: 42 }, makeSettingsAdmission())
          .pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.deepEqual(events, ["read-1"]);
        yield* Deferred.succeed(gate.release, undefined);
        yield* Fiber.join(load);
        yield* Fiber.join(save);
      }),
    );

    assert.deepEqual(events, ["read-1", "read-2", "save"]);
    assert.equal(fake.documents.get("/agent/code-previews.json")?.readCollapsedLines, 42);
    assert.equal(codePreviewSettings.readCollapsedLines, 42);
  }).pipe(Effect.scoped),
);

it.effect("a stale save returns before document modification", () => {
  const fake = makeInMemoryDocuments();
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const stale = makeSettingsAdmission();
      yield* service.load(makeSettingsAdmission());
      const published = codePreviewSettings;
      yield* service.save({ ...defaultCodePreviewSettings, readCollapsedLines: 99 }, stale);
      assert.equal(fake.updateCount, 0);
      assert.equal(codePreviewSettings, published);
    }),
  );
});

it.effect("flush in another Layer waits for one-shot rehydrate and save", () =>
  Effect.gen(function* () {
    const saveStarted = yield* Deferred.make<void>();
    const releaseSave = yield* Deferred.make<void>();
    let flushCompleted = false;
    const fake = makeInMemoryDocuments();
    fake.blockNextUpdateBeforeCommit(saveStarted, releaseSave);
    setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 17 });
    const save = yield* usingSettings(fake.service, (service) =>
      service.save(
        { ...defaultCodePreviewSettings, readCollapsedLines: 42 },
        makeSettingsAdmission(),
        { rehydrate: {} },
      ),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(saveStarted);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);

    const flush = yield* usingSettings(fake.service, (service) => service.flush).pipe(
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
    "/agent/code-previews.json": {
      owner: "keep",
      codePreview: { readCollapsedLines: 12 },
      readCollapsedLines: 17,
    },
  });
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      assert.equal(Object.hasOwn(loaded, "owner"), false);
      yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 });
      // A legacy nested block is an unknown root field: preserved verbatim, never migrated.
      assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
        owner: "keep",
        codePreview: { readCollapsedLines: 12 },
        readCollapsedLines: 42,
      });
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
      assert.equal(Object.isFrozen(codePreviewSettings), true);
    }),
  );
});

it.effect("save preserves concurrently changed known fields that the caller did not edit", () => {
  const fake = makeInMemoryDocuments({
    "/agent/code-previews.json": {
      owner: "initial",
      shikiTheme: "github-dark",
      readCollapsedLines: 17,
    },
  });
  return usingSettings(fake.service, (service) =>
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
  );
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
  return usingSettings(documents, (service) =>
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
  );
});

it.effect("runtime-invalid settings fail before document modification or publication", () => {
  const fake = makeInMemoryDocuments();
  return usingSettings(fake.service, (service) =>
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
  );
});

it.effect("flush waits for an earlier save and interruption cannot lose that save", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const fake = makeInMemoryDocuments();
    fake.blockNextUpdateBeforeCommit(started, release);
    yield* usingSettings(fake.service, (service) =>
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
    );
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
    yield* usingSettings(fake.service, (service) =>
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
    );
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
    const fiber = yield* usingSettings(documents, loadSettings).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);
    yield* Fiber.interrupt(fiber);
    assert.equal(interrupted, 1);
    assert.equal(codePreviewSettings.readCollapsedLines, 17);
  }).pipe(Effect.scoped),
);

it.effect("choosing the project's value writes a global override instead of deleting one", () => {
  const fake = makeInMemoryDocuments({
    "/project/.pi/settings.json": { codePreview: { shikiTheme: "nord" } },
    "/agent/code-previews.json": { shikiTheme: "github-dark" },
  });
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const project = { projectCwd: "/project", projectTrusted: true };
      const loaded = yield* service.load(makeSettingsAdmission(), project);
      assert.equal(loaded.shikiTheme, "github-dark");
      yield* saveSettings(service, { ...loaded, shikiTheme: "nord" });
      // Deleting the override would leave other projects on the built-in theme.
      assert.equal((yield* loadSettings(service)).shikiTheme, "nord");
    }),
  );
});

it.effect("restoring defaults removes overrides so settings.json values apply again", () => {
  const fake = makeInMemoryDocuments({
    "/agent/settings.json": { codePreview: { shikiTheme: "nord" } },
    "/agent/code-previews.json": {
      owner: "keep",
      shikiTheme: "github-dark",
      readCollapsedLines: 40,
    },
  });
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      assert.equal((yield* loadSettings(service)).shikiTheme, "github-dark");
      yield* service.reset(makeSettingsAdmission());
      assert.deepEqual(fake.documents.get("/agent/code-previews.json"), { owner: "keep" });
      assert.equal(codePreviewSettings.shikiTheme, "nord");
      assert.equal(
        codePreviewSettings.readCollapsedLines,
        defaultCodePreviewSettings.readCollapsedLines,
      );
    }),
  );
});

it.effect("saves and resets that another process already wrote still apply here", () => {
  const fake = makeInMemoryDocuments();
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      fake.documents.set("/agent/code-previews.json", { readCollapsedLines: 42 });
      yield* saveSettings(service, { ...loaded, readCollapsedLines: 42 });
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
      fake.documents.set("/agent/code-previews.json", {});
      yield* service.reset(makeSettingsAdmission());
      assert.equal(
        codePreviewSettings.readCollapsedLines,
        defaultCodePreviewSettings.readCollapsedLines,
      );
    }),
  );
});

it.effect("saving unchanged settings writes nothing", () => {
  const fake = makeInMemoryDocuments();
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      yield* saveSettings(service, yield* loadSettings(service));
      assert.equal(fake.documents.has("/agent/code-previews.json"), false);
    }),
  );
});

const nestedSettingsCases: ReadonlyArray<readonly [string, JsonValue, number]> = [
  ["object", { readCollapsedLines: 21, futureSetting: { enabled: true } }, 21],
  ["null", null, defaultCodePreviewSettings.readCollapsedLines],
  ["array", [{ readCollapsedLines: 21 }], defaultCodePreviewSettings.readCollapsedLines],
  ["string", "21", defaultCodePreviewSettings.readCollapsedLines],
  ["number", 21, defaultCodePreviewSettings.readCollapsedLines],
  ["boolean", true, defaultCodePreviewSettings.readCollapsedLines],
];

it.effect.each(nestedSettingsCases)(
  "settings.json contributes only a nested JSON object: %s",
  ([, nested, expected]) => {
    const fake = makeInMemoryDocuments({
      "/agent/settings.json": { codePreview: nested },
      "/agent/code-previews.json": { shikiTheme: "nord" },
    });
    return usingSettings(fake.service, (service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        assert.equal(loaded.readCollapsedLines, expected);
        assert.equal(loaded.shikiTheme, "nord");
        // A non-object block is ignored silently, never reported as an unreadable file.
        assert.deepEqual(codePreviewSettingsProblems, []);
      }),
    );
  },
);

it.effect("loads publish which files were ignored and which fields were invalid", () => {
  const fake = makeInMemoryDocuments({
    "/agent/code-previews.json": { readCollapsedLines: -1, shikiTheme: "github-dark" },
  });
  const documents = JsonDocumentStore.of({
    ...fake.service,
    readObject: (path) =>
      path === "/agent/settings.json"
        ? Effect.fail(new JsonDocumentError({ operation: "read", path, message: "Invalid JSON." }))
        : fake.service.readObject(path),
  });
  return usingSettings(documents, (service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      assert.equal(loaded.shikiTheme, "github-dark");
      assert.deepEqual(codePreviewSettingsProblems, [
        { path: "/agent/settings.json" },
        { path: "/agent/code-previews.json", fields: ["readCollapsedLines"] },
      ]);
    }),
  );
});
