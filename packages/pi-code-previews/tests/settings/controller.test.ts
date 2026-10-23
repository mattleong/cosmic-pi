import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { deferredPromise, extensionContextFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { vi } from "vitest";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../../src/application/capability";
import { nextSettingsAdmission, withSettingsCoordinator } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { CodePreviewSettingsService } from "../../src/config/service";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { codePreviewSettingsSubcommand } from "../../src/settings/controller";
import { step } from "../support/effect-test";
import { inertScheduler } from "../support/renderer-host";
import * as Arr from "effect/Array";

const inertCapability = (): CodePreviewSessionCapability => ({
  ...inertScheduler,
  run: () => Promise.reject(new Error("unexpected settings runtime call")),
});

for (const action of ["", "readCollapsedLines 40"])
  for (const retirement of ["shutdown", "replacement"])
    it.effect(
      `pending settings ${action ? "assignment" : "panel"} cannot act after ${retirement}`,
      () =>
        Effect.gen(function* () {
          const initial = inertCapability();
          installCodePreviewSessionCapability(initial);
          setCodePreviewSettings(defaultCodePreviewSettings);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              clearCodePreviewSessionCapability();
              setCodePreviewSettings(defaultCodePreviewSettings);
            }),
          );
          const loading = deferredPromise<typeof import("../../src/settings/panel")>();
          const entered = yield* Deferred.make<void>();
          let saves = 0;
          const panel = {
            persistSettingsChange: (next) => {
              saves++;
              setCodePreviewSettings(next);
              return Promise.resolve();
            },
            createCodePreviewSettingsModel: () => {
              throw new Error("a retired panel must not be constructed");
            },
          } satisfies typeof import("../../src/settings/panel");
          const command = codePreviewSettingsSubcommand(() => {
            Deferred.doneUnsafe(entered, Effect.void);
            return loading.promise;
          });
          const notifications: string[] = [];
          const host = fakeCustomSurfaceHost();
          const signal = yield* Effect.abortSignal;
          const ctx = extensionContextFixture({
            mode: "tui",
            hasUI: true,
            signal,
            ui: {
              custom: host.ctx.ui.custom.bind(host.ctx.ui),
              notify: (message) => notifications.push(message),
            },
          });
          const pending = Promise.resolve(command.handler(action, ctx));
          yield* Deferred.await(entered);
          if (retirement === "shutdown") clearCodePreviewSessionCapability(initial);
          else installCodePreviewSessionCapability(inertCapability());
          loading.resolve(panel);
          yield* step(() => pending);
          host.mount();
          assert.equal(host.editor, undefined);
          assert.equal(saves, 0);
          assert.deepEqual(notifications, []);
          assert.deepEqual(codePreviewSettings, defaultCodePreviewSettings);
          if (retirement === "shutdown") installCodePreviewSessionCapability(inertCapability());
          yield* step(() => Promise.resolve(command.handler("readCollapsedLines 40", ctx)));
          assert.equal(saves, 1);
          assert.equal(codePreviewSettings.readCollapsedLines, 40);
        }),
    );

for (const action of ["", "readCollapsedLines 40"])
  for (const liveSignal of ["cleared", "replaced"])
    for (const settlement of ["resolve", "reject"])
      it.effect(
        `aborted settings ${action ? "assignment" : "panel"} stays silent when its ${liveSignal} signal's loader ${settlement}s`,
        () =>
          Effect.gen(function* () {
            installCodePreviewSessionCapability(inertCapability());
            setCodePreviewSettings(defaultCodePreviewSettings);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                clearCodePreviewSessionCapability();
                setCodePreviewSettings(defaultCodePreviewSettings);
              }),
            );
            const loading = deferredPromise<typeof import("../../src/settings/panel")>();
            const entered = yield* Deferred.make<void>();
            let saves = 0;
            let models = 0;
            const panel = {
              persistSettingsChange: () => {
                saves++;
                return Promise.resolve();
              },
              createCodePreviewSettingsModel: () => {
                models++;
                throw new Error("an aborted panel must not be constructed");
              },
            } satisfies typeof import("../../src/settings/panel");
            const command = codePreviewSettingsSubcommand(() => {
              Deferred.doneUnsafe(entered, Effect.void);
              return loading.promise;
            });
            const notifications: string[] = [];
            const host = fakeCustomSurfaceHost();
            const original = new AbortController();
            let signal: AbortSignal | undefined = original.signal;
            const ctx = extensionContextFixture({
              mode: "tui",
              hasUI: true,
              ui: {
                custom: host.ctx.ui.custom.bind(host.ctx.ui),
                notify: (message) => notifications.push(message),
              },
            });
            Object.defineProperty(ctx, "signal", { get: () => signal });
            const pending = Promise.resolve(command.handler(action, ctx));
            yield* Deferred.await(entered);
            original.abort();
            signal = liveSignal === "cleared" ? undefined : new AbortController().signal;
            if (settlement === "resolve") loading.resolve(panel);
            else loading.reject(new Error("late module load failure"));
            yield* step(() => pending);
            assert.equal(models, 0);
            assert.equal(saves, 0);
            assert.equal(host.pendingMounts, 0);
            assert.equal(host.editor, undefined);
            assert.deepEqual(notifications, []);
            assert.deepEqual(codePreviewSettings, defaultCodePreviewSettings);
          }),
      );

it.effect(
  "an admitted settings save can commit after abort without syntax follow-up or notification",
  () =>
    Effect.gen(function* () {
      installCodePreviewSessionCapability(inertCapability());
      setCodePreviewSettings(defaultCodePreviewSettings);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          clearCodePreviewSessionCapability();
          setCodePreviewSettings(defaultCodePreviewSettings);
        }),
      );
      const panel = yield* step(() => import("../../src/settings/panel"));
      const entered = yield* Deferred.make<void>();
      const commit = deferredPromise();
      let syntaxInitializations = 0;
      const command = codePreviewSettingsSubcommand(() =>
        Promise.resolve({
          ...panel,
          persistSettingsChange: (updated, previous, options, _effects, isCurrent, editedKeys) =>
            panel.persistSettingsChange(
              updated,
              previous,
              options,
              {
                queueSave: (saved) => {
                  Deferred.doneUnsafe(entered, Effect.void);
                  return commit.promise.then(() => setCodePreviewSettings(saved));
                },
                queueReset: () => Promise.resolve(),
                initializeSyntax: () => {
                  syntaxInitializations++;
                  return Promise.resolve();
                },
              },
              isCurrent,
              editedKeys,
            ),
        }),
      );
      const notifications: string[] = [];
      const original = new AbortController();
      let signal: AbortSignal | undefined = original.signal;
      const ctx = extensionContextFixture({
        ui: { notify: (message) => notifications.push(message) },
      });
      Object.defineProperty(ctx, "signal", { get: () => signal });
      const pending = Promise.resolve(command.handler("shikiTheme nord", ctx));
      yield* Deferred.await(entered);
      original.abort();
      signal = undefined;
      commit.resolve();
      yield* step(() => pending);
      assert.equal(codePreviewSettings.shikiTheme, "nord");
      assert.equal(syntaxInitializations, 0);
      assert.deepEqual(notifications, []);
    }),
);

it.effect("a rejected settings implementation load is reported safely and can be retried", () =>
  Effect.gen(function* () {
    installCodePreviewSessionCapability(inertCapability());
    setCodePreviewSettings(defaultCodePreviewSettings);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearCodePreviewSessionCapability();
        setCodePreviewSettings(defaultCodePreviewSettings);
      }),
    );
    let failed = false;
    const command = codePreviewSettingsSubcommand(() => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error("secret module path"));
      }
      return Promise.resolve({
        persistSettingsChange: (next) => {
          setCodePreviewSettings(next);
          return Promise.resolve();
        },
        createCodePreviewSettingsModel: () => {
          throw new Error("the retry assigns a setting instead of opening a panel");
        },
      });
    });
    const notifications: string[] = [];
    const host = fakeCustomSurfaceHost();
    const signal = yield* Effect.abortSignal;
    const ctx = extensionContextFixture({
      mode: "tui",
      hasUI: true,
      signal,
      ui: {
        custom: host.ctx.ui.custom.bind(host.ctx.ui),
        notify: (message) => notifications.push(message),
      },
    });
    yield* step(() => Promise.resolve(command.handler("", ctx)));
    assert.equal(notifications.length, 1);
    assert.doesNotMatch(Arr.join(notifications, "\n"), /secret module path/);
    yield* step(() => Promise.resolve(command.handler("readCollapsedLines 40", ctx)));
    assert.equal(codePreviewSettings.readCollapsedLines, 40);
    assert.equal(notifications.length, 2);
    assert.doesNotMatch(Arr.join(notifications, "\n"), /secret module path/);
  }),
);

const decodeSavedSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const overlappingSettingsCommands = (commands: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "code-previews-commands-" });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const runtime = ManagedRuntime.make(codePreviewApplicationLayer);
    yield* Effect.addFinalizer(() => runtime.disposeEffect);
    const capability: CodePreviewSessionCapability = {
      ...inertScheduler,
      run: (effect, signal) => runtime.runPromise(effect, { signal }),
    };
    installCodePreviewSessionCapability(capability);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearCodePreviewSessionCapability(capability);
        setCodePreviewSettings(defaultCodePreviewSettings);
      }),
    );
    yield* step(() =>
      runtime.runPromise(
        CodePreviewSettingsService.use((service) => service.load(nextSettingsAdmission())),
      ),
    );

    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
    const blocked = runtime.runPromise(
      withSettingsCoordinator(nextSettingsAdmission(), () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    yield* Deferred.await(started);
    const command = codePreviewSettingsSubcommand();
    const signal = yield* Effect.abortSignal;
    const ctx = extensionContextFixture({ signal });
    const pending = Arr.map(commands, (args) => Promise.resolve(command.handler(args, ctx)));
    yield* Deferred.succeed(release, undefined);
    yield* step(() => Promise.all([blocked, ...pending]));

    return {
      published: codePreviewSettings,
      saved: decodeSavedSettings(yield* fs.readFileString(`${agentDir}/code-previews.json`)),
    };
  });

it.effect("overlapping assignments to different fields preserve both edits", () =>
  overlappingSettingsCommands(["readCollapsedLines 40", "readLineNumbers off"]).pipe(
    Effect.tap(({ published, saved }) =>
      Effect.sync(() => {
        assert.equal(published.readCollapsedLines, 40);
        assert.equal(published.readLineNumbers, false);
        assert.equal(saved.readCollapsedLines, 40);
        assert.equal(saved.readLineNumbers, false);
      }),
    ),
    Effect.provide(nodeFilePlatformLayer),
  ),
);

it.effect("settings edits wait until a session has loaded the settings they change", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "code-previews-unloaded-" });
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
    const file = `${agentDir}/code-previews.json`;
    const overrides = '{"readCollapsedLines":40,"pathIcons":"nerd"}';
    yield* fs.writeFileString(file, overrides);
    const settings = codePreviewSettingsSubcommand();
    const host = fakeCustomSurfaceHost();
    const notifications: string[] = [];
    const ctx = extensionContextFixture({
      mode: "tui",
      hasUI: true,
      ui: {
        custom: host.ctx.ui.custom.bind(host.ctx.ui),
        notify: (message: string) => notifications.push(message),
      },
    });

    yield* step(() => Promise.resolve(settings.handler("readCollapsedLines 20", ctx)));
    const opening = Promise.resolve(settings.handler("", ctx));
    host.mount();
    assert.equal(host.editor, undefined);
    yield* step(() => opening);

    assert.equal(yield* fs.readFileString(file), overrides);
    assert.equal(notifications.length, 2);
  }).pipe(Effect.provide(nodeFilePlatformLayer)),
);
