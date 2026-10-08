import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { fakeCustomSurfaceHost } from "pi-cosmic-ui/testing";
import { vi } from "vitest";
import { codePreviewSettingsSubcommand } from "../../src/settings/controller";
import { step } from "../support/effect-test";

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
      ui: { custom: host.ctx.ui.custom, notify: (message: string) => notifications.push(message) },
    });

    // No session has loaded the settings, so an edit would be built from guessed values.
    yield* step(() => Promise.resolve(settings.handler("readCollapsedLines 20", ctx)));
    const opening = Promise.resolve(settings.handler("", ctx));
    host.mount();
    assert.equal(host.editor, undefined);
    yield* step(() => opening);

    assert.equal(yield* fs.readFileString(file), overrides);
    assert.equal(notifications.length, 2);
  }).pipe(Effect.provide(nodeFilePlatformLayer)),
);
