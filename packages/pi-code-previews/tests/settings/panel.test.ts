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
      persistSettingsChange(settings, defaultCodePreviewSettings, loadOptions, {
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

effectTest("syntax follow-up uses the theme resolved from the committed document", function* () {
  const requested: CodePreviewSettings = {
    ...defaultCodePreviewSettings,
    readCollapsedLines: 40,
  };
  const initialized: string[] = [];
  yield* step(() =>
    persistSettingsChange(
      requested,
      defaultCodePreviewSettings,
      {},
      {
        queueSave: () => {
          setCodePreviewSettings({ ...requested, shikiTheme: "github-light" });
          return Promise.resolve();
        },
        queueReset: () => Promise.resolve(),
        initializeSyntax: (theme) => {
          initialized.push(theme);
          return Promise.resolve();
        },
      },
    ),
  );
  assert.deepEqual(initialized, ["github-light"]);
  setCodePreviewSettings(defaultCodePreviewSettings);
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
          defaultCodePreviewSettings,
          {},
          {
            queueSave: () => {
              setCodePreviewSettings(settings);
              return Promise.resolve();
            },
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
      setCodePreviewSettings(defaultCodePreviewSettings);
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
  assert.deepEqual(saved, []);
});

class DiskFull extends Data.TaggedError("DiskFull")<{ readonly message: string }> {}

effectTest("a completed save adopts merged fields before the next panel edit", function* () {
  setCodePreviewSettings(defaultCodePreviewSettings);
  const saved: CodePreviewSettings[] = [];
  const model = createCodePreviewSettingsModel({
    notify: () => undefined,
    done: () => undefined,
    loadOptions: {},
    effects: {
      queueSave: (next) => {
        saved.push(next);
        setCodePreviewSettings({ ...next, shikiTheme: "github-light" });
        return Promise.resolve();
      },
      queueReset: () => Promise.resolve(),
      initializeSyntax: () => Promise.resolve(),
    },
  });
  const list = listFor(model);
  model.onChange("readCollapsedLines", "40", list);
  yield* step(eventLoopTurn);
  model.onChange("readLineNumbers", "off", list);
  assert.equal(saved[1]?.shikiTheme, "github-light");
  assert.equal(saved[1]?.readCollapsedLines, 40);
  yield* step(eventLoopTurn);
  setCodePreviewSettings(defaultCodePreviewSettings);
});

for (const operation of ["save", "reset", "failure"] as const)
  effectTest(`retired settings panels suppress delayed ${operation} follow-up`, function* () {
    setCodePreviewSettings(defaultCodePreviewSettings);
    const pending = yield* Deferred.make<void, DiskFull>();
    let current = true;
    let writes = 0;
    let repaints = 0;
    let syntaxInitializations = 0;
    const notifications: string[] = [];
    const write = () => {
      writes++;
      return Effect.runPromise(Deferred.await(pending));
    };
    const model = createCodePreviewSettingsModel({
      notify: (message) => notifications.push(message),
      done: () => undefined,
      loadOptions: {},
      isCurrent: () => current,
      effects: {
        queueSave: write,
        queueReset: write,
        initializeSyntax: () => {
          syntaxInitializations++;
          return Promise.resolve();
        },
      },
    });
    const list = listFor(model);
    list.updateValue = () => {
      repaints++;
    };
    model.onChange(
      operation === "reset" ? "resetToDefaults" : "shikiTheme",
      operation === "reset" ? "reset now" : "github-light",
      list,
    );
    const initialRepaints = repaints;
    current = false;
    setCodePreviewSettings({ ...defaultCodePreviewSettings, shikiTheme: "github-dark" });
    if (operation === "failure")
      yield* Deferred.fail(pending, new DiskFull({ message: "disk full" }));
    else yield* Deferred.succeed(pending, undefined);
    yield* step(eventLoopTurn);
    model.onChange("readCollapsedLines", "40", list);
    assert.equal(writes, 1);
    assert.equal(repaints, initialRepaints);
    assert.equal(syntaxInitializations, 0);
    assert.deepEqual(notifications, []);
    setCodePreviewSettings(defaultCodePreviewSettings);
  });

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
    pending[0]!.fail();
    yield* step(eventLoopTurn);
    model.onChange("readLineNumbers", "off", list);
    assert.equal(pending[2]!.next.readCollapsedLines, 40);
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
