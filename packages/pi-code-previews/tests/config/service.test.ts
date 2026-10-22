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
} from "pi-cosmic-core";
import {
  capturedTelemetrySnapshot,
  makeCapturedLogger,
  makeInMemoryDocuments,
  type InMemoryDocuments,
} from "pi-cosmic-core/testing";
import { nextSettingsAdmission } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import {
  codePreviewSettings,
  codePreviewSettingsProblems,
  setCodePreviewSettings,
} from "../../src/config/state";
import {
  CodePreviewSettingsService,
  formatSettingsSaveError,
  type CodePreviewSettingsServiceContract,
} from "../../src/config/store";
import { issueMessageStyleProblems } from "../../testing";

const loadSettings = (service: CodePreviewSettingsServiceContract) =>
  service.load(nextSettingsAdmission());
const saveSettings = (service: CodePreviewSettingsServiceContract, settings: CodePreviewSettings) =>
  service.save(settings, nextSettingsAdmission());

function settingsLayer(documents: JsonDocumentStoreContract) {
  const dependencies = Layer.mergeAll(
    AgentDirectory.layer("/agent"),
    NodePath.layer,
    Layer.succeed(JsonDocumentStore, documents),
  );
  return CodePreviewSettingsService.layer.pipe(Layer.provide(dependencies));
}

const usingSettings = <A, E, R>(
  documents: JsonDocumentStoreContract,
  use: (service: CodePreviewSettingsServiceContract) => Effect.Effect<A, E, R>,
) =>
  // Each call builds an independent service, like separate session runtimes.
  CodePreviewSettingsService.use(use).pipe(
    provideBuiltLayer(settingsLayer(documents), { local: true }),
  );

const gateFirstRead = (fake: InMemoryDocuments, onRead: (read: number) => void = () => undefined) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let reads = 0;
    const documents = JsonDocumentStore.of({
      ...fake.service,
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

it.effect("a cancelled newer load does not suppress an older successful publication", () =>
  Effect.gen(function* () {
    const gate = yield* gateFirstRead(
      makeInMemoryDocuments({
        "/agent/settings.json": { codePreview: { readCollapsedLines: 31 } },
      }),
    );
    const olderAdmission = nextSettingsAdmission();
    const newerAdmission = nextSettingsAdmission();
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
        const load = yield* service.load(nextSettingsAdmission()).pipe(Effect.forkScoped);
        yield* Deferred.await(gate.started);
        const save = yield* service
          .save({ ...defaultCodePreviewSettings, readCollapsedLines: 42 }, nextSettingsAdmission())
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

it.effect("an overtaken save still applies an edit to a different setting", () => {
  const fake = makeInMemoryDocuments();
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const loaded = yield* loadSettings(service);
      const earlier = nextSettingsAdmission();
      yield* service.save({ ...loaded, pathIcons: "off" }, nextSettingsAdmission(), {
        previous: loaded,
      });
      yield* service.load(nextSettingsAdmission());
      yield* service.save({ ...loaded, readCollapsedLines: 42 }, earlier, { previous: loaded });

      assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
        pathIcons: "off",
        readCollapsedLines: 42,
      });
      assert.equal(codePreviewSettings.pathIcons, "off");
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
    }),
  );
});

it.effect("an overtaken save keeps the project context of another runtime's newer load", () => {
  const fake = makeInMemoryDocuments({
    "/a/.pi/settings.json": { codePreview: { shikiTheme: "nord" } },
    "/b/.pi/settings.json": { codePreview: { shikiTheme: "github-dark" } },
  });
  return usingSettings(fake.service, (first) =>
    usingSettings(fake.service, (second) =>
      Effect.gen(function* () {
        const loaded = yield* first.load(nextSettingsAdmission(), {
          projectCwd: "/a",
          projectTrusted: true,
        });
        const earlier = nextSettingsAdmission();
        yield* second.load(nextSettingsAdmission(), { projectCwd: "/b", projectTrusted: true });
        yield* first.save({ ...loaded, readCollapsedLines: 42 }, earlier, { previous: loaded });

        assert.deepEqual(fake.documents.get("/agent/code-previews.json"), {
          readCollapsedLines: 42,
        });
        assert.equal(codePreviewSettings.shikiTheme, "github-dark");
        assert.equal(codePreviewSettings.readCollapsedLines, 42);
      }),
    ),
  );
});

it.effect.each(["save", "reset"] as const)(
  "an overtaken save of a setting the later %s changed fails as superseded",
  (operation) => {
    const fake = makeInMemoryDocuments({ "/agent/code-previews.json": { readCollapsedLines: 17 } });
    return usingSettings(fake.service, (service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        const earlier = nextSettingsAdmission();
        if (operation === "save")
          yield* service.save({ ...loaded, readCollapsedLines: 42 }, nextSettingsAdmission(), {
            previous: loaded,
          });
        else yield* service.reset(nextSettingsAdmission());
        const committed = fake.documents.get("/agent/code-previews.json");
        const published = codePreviewSettings;

        const failure = yield* Effect.flip(
          service.save({ ...loaded, readCollapsedLines: 99 }, earlier, { previous: loaded }),
        );

        assert.equal(failure._tag, "CodePreviewSettingsSuperseded");
        assert.deepEqual(issueMessageStyleProblems(formatSettingsSaveError(failure)), []);
        assert.deepEqual(fake.documents.get("/agent/code-previews.json"), committed);
        assert.equal(codePreviewSettings, published);
      }),
    );
  },
);

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
        nextSettingsAdmission(),
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
      assert.equal(codePreviewSettings.shikiTheme, "github-light");
      assert.equal(codePreviewSettings.readCollapsedLines, 42);
      yield* saveSettings(service, { ...codePreviewSettings, pathIcons: "off" });
      assert.equal(fake.documents.get("/agent/code-previews.json")?.shikiTheme, "github-light");
      assert.equal(codePreviewSettings.shikiTheme, "github-light");
    }),
  );
});

it.effect.each(["failure", "reset"] as const)(
  "a captured edit does not restore earlier draft changes after %s",
  (operation) => {
    const fake = makeInMemoryDocuments({
      "/agent/code-previews.json": { readCollapsedLines: 17, shikiTheme: "github-dark" },
    });
    let failNext = operation === "failure";
    const documents = JsonDocumentStore.of({
      ...fake.service,
      modifyObject: (path, modify) =>
        Effect.suspend(() => {
          if (!failNext) return fake.service.modifyObject(path, modify);
          failNext = false;
          return Effect.fail(
            new JsonDocumentError({ operation: "write", path, message: "disk full" }),
          );
        }),
    });
    return usingSettings(documents, (service) =>
      Effect.gen(function* () {
        const loaded = yield* loadSettings(service);
        const first = { ...loaded, readCollapsedLines: 40 };
        const second = { ...first, readLineNumbers: false };
        const save = service.save(first, nextSettingsAdmission(), { previous: loaded });
        if (operation === "failure") yield* Effect.flip(save);
        else {
          yield* save;
          yield* service.reset(nextSettingsAdmission());
        }
        yield* service.save(second, nextSettingsAdmission(), { previous: first });

        const expected = operation === "failure" ? loaded : defaultCodePreviewSettings;
        assert.equal(codePreviewSettings.readCollapsedLines, expected.readCollapsedLines);
        assert.equal(codePreviewSettings.shikiTheme, expected.shikiTheme);
        assert.equal(codePreviewSettings.readLineNumbers, false);
        assert.equal(fake.documents.get("/agent/code-previews.json")?.readLineNumbers, false);
      }),
    );
  },
);

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
          .save({ ...loaded, readCollapsedLines: 42 }, nextSettingsAdmission())
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
          .save({ ...loaded, readCollapsedLines: 42 }, nextSettingsAdmission())
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

it.effect("choosing the project's value writes a global override instead of deleting one", () => {
  const fake = makeInMemoryDocuments({
    "/project/.pi/settings.json": { codePreview: { shikiTheme: "nord" } },
    "/agent/code-previews.json": { shikiTheme: "github-dark" },
  });
  return usingSettings(fake.service, (service) =>
    Effect.gen(function* () {
      const project = { projectCwd: "/project", projectTrusted: true };
      const loaded = yield* service.load(nextSettingsAdmission(), project);
      assert.equal(loaded.shikiTheme, "github-dark");
      yield* saveSettings(service, { ...loaded, shikiTheme: "nord" });
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
      yield* service.reset(nextSettingsAdmission());
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
      yield* service.reset(nextSettingsAdmission());
      assert.equal(
        codePreviewSettings.readCollapsedLines,
        defaultCodePreviewSettings.readCollapsedLines,
      );
    }),
  );
});

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
