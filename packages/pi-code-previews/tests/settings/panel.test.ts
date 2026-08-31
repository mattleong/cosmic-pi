import assert from "node:assert/strict";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { persistSettingsChange } from "../../src/settings/panel";
import { effectTest, eventLoopTurn, step } from "../support/effect-test";

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
