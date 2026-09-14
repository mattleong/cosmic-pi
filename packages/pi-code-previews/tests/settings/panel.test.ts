import assert from "node:assert/strict";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { updateSetting } from "../../src/config/values";
import { persistSettingsChange } from "../../src/settings/panel";
import { effectTest, eventLoopTurn, step } from "../support/effect-test";

effectTest("collapsed style edits persist without reinitializing syntax", function* () {
  const saved: CodePreviewSettings[] = [];
  const loadOptions = { projectCwd: "/trusted-project", projectTrusted: true };
  let initializations = 0;
  let settings = defaultCodePreviewSettings;
  for (const style of ["compact", "preview"]) {
    settings = updateSetting(settings, "toolCallCollapsedStyle", style);
    yield* step(() =>
      persistSettingsChange(settings, defaultCodePreviewSettings.shikiTheme, loadOptions, {
        queueSave: (next, options) => {
          assert.deepEqual(options, loadOptions);
          saved.push(next);
          return Promise.resolve();
        },
        initializeSyntax: () => {
          initializations++;
          return Promise.resolve();
        },
      }),
    );
  }
  assert.deepEqual(saved, [
    { ...defaultCodePreviewSettings, toolCallCollapsedStyle: "compact" },
    defaultCodePreviewSettings,
  ]);
  assert.equal(initializations, 0);
});

effectTest(
  "a detached Shiki initialization rejection does not escape into save rollback or warnings",
  function* () {
    const rejection = new Error("Shiki initialization failed");
    const unhandled: Error[] = [];
    const onUnhandled = (reason: Error) => {
      if (reason === rejection) unhandled.push(reason);
    };
    const settings: CodePreviewSettings = {
      ...defaultCodePreviewSettings,
      shikiTheme: "github-light",
    };
    let initializations = 0;
    let rollbackWarnings = 0;
    process.on("unhandledRejection", onUnhandled);

    try {
      yield* step(() =>
        persistSettingsChange(
          settings,
          defaultCodePreviewSettings.shikiTheme,
          {},
          {
            queueSave: () => Promise.resolve(),
            initializeSyntax: () => {
              initializations++;
              return Promise.reject(rejection);
            },
          },
        ).catch(() => {
          rollbackWarnings++;
        }),
      );
      yield* step(eventLoopTurn);

      assert.equal(initializations, 1);
      assert.equal(rollbackWarnings, 0);
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  },
);
