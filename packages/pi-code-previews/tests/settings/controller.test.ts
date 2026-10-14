import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionContextFixture } from "pi-cosmic-core/testing";
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
    const pending = commands.map((args) => Promise.resolve(command.handler(args, ctx)));
    yield* Deferred.succeed(release, undefined);
    yield* step(() => Promise.all([blocked, ...pending]));

    return {
      published: codePreviewSettings,
      saved: decodeSavedSettings(yield* fs.readFileString(`${agentDir}/code-previews.json`)),
    };
  });

it.effect("overlapping assignments can restore the original default", () =>
  overlappingSettingsCommands([
    "readCollapsedLines 40",
    `readCollapsedLines ${defaultCodePreviewSettings.readCollapsedLines}`,
  ]).pipe(
    Effect.tap(({ published, saved }) =>
      Effect.sync(() => {
        assert.equal(published.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
        assert.equal(Object.hasOwn(saved, "readCollapsedLines"), false);
      }),
    ),
    Effect.provide(nodeFilePlatformLayer),
  ),
);

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
