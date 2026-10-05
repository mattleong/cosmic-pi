import assert from "node:assert/strict";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { updateSetting } from "../../src/config/values";
import { SettingsList } from "@earendil-works/pi-tui";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { createCodePreviewSettingsModel, persistSettingsChange } from "../../src/settings/panel";
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
        queueReset: () => Promise.reject(new Error("unexpected reset")),
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
            queueReset: () => Promise.resolve(),
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

const plainListTheme = {
  label: (text: string) => text,
  value: (text: string) => text,
  description: (text: string) => text,
  cursor: ">",
  hint: (text: string) => text,
};
const listFor = (model: ReturnType<typeof createCodePreviewSettingsModel>) =>
  new SettingsList(
    model.items,
    10,
    plainListTheme,
    () => undefined,
    () => undefined,
  );

effectTest("restoring defaults waits for a second press and saves no values", function* () {
  const saved: CodePreviewSettings[] = [];
  let resets = 0;
  const model = createCodePreviewSettingsModel({
    notify: () => undefined,
    done: () => undefined,
    loadOptions: {},
    effects: {
      queueSave: (next) => {
        saved.push(next);
        return Promise.resolve();
      },
      queueReset: () => {
        resets++;
        return Promise.resolve();
      },
      initializeSyntax: () => Promise.resolve(),
    },
  });
  const list = listFor(model);
  model.onChange("resetToDefaults", "press Enter to reset", list);
  yield* step(eventLoopTurn);
  assert.equal(resets, 0);
  model.onChange("resetToDefaults", "reset now", list);
  yield* step(eventLoopTurn);
  assert.equal(resets, 1);
  // Restoring removes overrides; it never writes the built-in values over settings.json.
  assert.deepEqual(saved, []);
});

class DiskFull extends Data.TaggedError("DiskFull")<{ readonly message: string }> {}

effectTest(
  "only the latest failed edit rolls the panel back to the published settings",
  function* () {
    setCodePreviewSettings(defaultCodePreviewSettings);
    const pending: Array<{ next: CodePreviewSettings; fail: () => void; pass: () => void }> = [];
    const warnings: string[] = [];
    const model = createCodePreviewSettingsModel({
      notify: (message, level) => {
        if (level === "warning") warnings.push(message);
      },
      done: () => undefined,
      loadOptions: {},
      effects: {
        queueSave: (next) => {
          const save = Deferred.makeUnsafe<void, DiskFull>();
          pending.push({
            next,
            pass: () => Deferred.doneUnsafe(save, Effect.void),
            fail: () =>
              Deferred.doneUnsafe(save, Effect.fail(new DiskFull({ message: "disk full" }))),
          });
          return Effect.runPromise(Deferred.await(save));
        },
        queueReset: () => Promise.resolve(),
        initializeSyntax: () => Promise.resolve(),
      },
    });
    const list = listFor(model);
    model.onChange("readCollapsedLines", "20", list);
    model.onChange("readCollapsedLines", "40", list);
    // An older failure leaves the newer draft in place.
    pending[0]!.fail();
    yield* step(eventLoopTurn);
    model.onChange("readLineNumbers", "off", list);
    assert.equal(pending[2]!.next.readCollapsedLines, 40);
    // The latest failure restores what was actually published.
    pending[1]!.pass();
    pending[2]!.fail();
    yield* step(eventLoopTurn);
    model.onChange("pathIcons", "off", list);
    assert.equal(
      pending[3]!.next.readCollapsedLines,
      defaultCodePreviewSettings.readCollapsedLines,
    );
    assert.equal(pending[3]!.next.readLineNumbers, defaultCodePreviewSettings.readLineNumbers);
    assert.equal(warnings.length, 2);
  },
);
