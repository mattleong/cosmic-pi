import assert from "node:assert/strict";
import * as NodePath from "@effect/platform-node/NodePath";
import { SettingsList } from "@earendil-works/pi-tui";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentDirectory } from "pi-cosmic-core";
import { makeInMemoryDocuments, type InMemoryDocuments } from "pi-cosmic-core/testing";
import { nextSettingsAdmission } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import {
  CodePreviewSettingsService,
  CodePreviewSettingsSuperseded,
  type CodePreviewSettingsServiceContract,
} from "../../src/config/store";
import { createCodePreviewSettingsModel, persistSettingsChange } from "../../src/settings/panel";
import { createSettingsCategoryItems } from "../../src/settings/ui/index";
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

class DiskFull extends Schema.TaggedError<DiskFull, { readonly brand: unique symbol }>()(
  "DiskFull",
  { message: Schema.String },
) {}

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
      yield* Deferred.fail(pending, DiskFull.make({ message: "disk full" }));
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
              Deferred.doneUnsafe(save, Effect.fail(DiskFull.make({ message: "disk full" }))),
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

effectTest("only the latest superseded panel edit reports that it was not saved", function* () {
  setCodePreviewSettings(defaultCodePreviewSettings);
  const pending: Array<() => void> = [];
  const warnings: string[] = [];
  const model = createCodePreviewSettingsModel({
    notify: (message, level) => {
      if (level === "warning") warnings.push(message);
    },
    done: () => undefined,
    loadOptions: {},
    effects: {
      queueSave: () => {
        const save = Deferred.makeUnsafe<void, CodePreviewSettingsSuperseded>();
        pending.push(() =>
          Deferred.doneUnsafe(
            save,
            Effect.fail(CodePreviewSettingsSuperseded.make({ message: "superseded" })),
          ),
        );
        return Effect.runPromise(Deferred.await(save));
      },
      queueReset: () => Promise.resolve(),
      initializeSyntax: () => Promise.resolve(),
    },
  });
  const list = listFor(model);
  model.onChange("readCollapsedLines", "20", list);
  model.onChange("readCollapsedLines", "40", list);
  pending[0]!();
  yield* step(eventLoopTurn);
  assert.equal(warnings.length, 0);
  model.onChange("readLineNumbers", "off", list);

  pending[2]!();
  yield* step(eventLoopTurn);
  assert.equal(warnings.length, 1);
});

const settingsFile = "/agent/code-previews.json";

const buildSettingsService = (fake: InMemoryDocuments) =>
  Layer.build(
    CodePreviewSettingsService.layer.pipe(
      Layer.provide(Layer.mergeAll(AgentDirectory.layer("/agent"), NodePath.layer, fake.layer)),
    ),
  ).pipe(Effect.map((context) => Context.get(context, CodePreviewSettingsService)));

// Panel saves go through the real settings service, but each one starts only when the test releases
// it, so completions can be reordered relative to admission.
function gatedPanelSaves(service: CodePreviewSettingsServiceContract) {
  const saves: Array<{ readonly release: () => void; readonly done: Promise<void> }> = [];
  const model = createCodePreviewSettingsModel({
    notify: () => undefined,
    done: () => undefined,
    loadOptions: {},
    effects: {
      queueSave: (settings, _options, previous, editedKeys) => {
        const admission = nextSettingsAdmission();
        const release = Deferred.makeUnsafe<void>();
        const done = Effect.runPromise(
          Deferred.await(release).pipe(
            Effect.andThen(
              service.save(settings, admission, {
                previous,
                ...(editedKeys && { editedKeys }),
              }),
            ),
          ),
        );
        saves.push({ release: () => Deferred.doneUnsafe(release, Effect.void), done });
        return done;
      },
      queueReset: () => Promise.resolve(),
      initializeSyntax: () => Promise.resolve(),
    },
  });
  const list = listFor(model);
  const shown = new Map<string, string>();
  list.updateValue = (id, value) => void shown.set(id, value);
  const complete = (index: number) =>
    Effect.gen(function* () {
      const save = saves[index]!;
      save.release();
      yield* step(() => save.done);
      yield* step(eventLoopTurn);
    });
  return { model, list, shown, complete };
}

const panelValuesFor = (settings: CodePreviewSettings) =>
  new Map(
    createSettingsCategoryItems(() => settings, Fn.constVoid).map((item) => [
      item.id,
      item.currentValue,
    ]),
  );

effectTest(
  "the panel follows the published settings when its saves finish out of order",
  function* () {
    setCodePreviewSettings(defaultCodePreviewSettings);
    const fake = makeInMemoryDocuments();
    const service = yield* buildSettingsService(fake);
    yield* service.load(nextSettingsAdmission());
    assert.equal(codePreviewSettings.shikiTheme, "dark-plus");
    const panel = gatedPanelSaves(service);

    panel.model.onChange("shikiTheme", "nord", panel.list);
    panel.model.onChange("pathIcons", "off", panel.list);
    yield* panel.complete(1);
    // The earlier theme edit is still pending, so the panel keeps showing it.
    assert.deepEqual(panel.shown, panelValuesFor({ ...codePreviewSettings, shikiTheme: "nord" }));

    yield* panel.complete(0);
    assert.deepEqual(fake.documents.get(settingsFile), { pathIcons: "off", shikiTheme: "nord" });
    assert.equal(codePreviewSettings.shikiTheme, "nord");
    assert.deepEqual(panel.shown, panelValuesFor(codePreviewSettings));

    panel.model.onChange("shikiTheme", "dark-plus", panel.list);
    yield* panel.complete(2);
    assert.equal(codePreviewSettings.shikiTheme, "dark-plus");
    assert.notEqual(fake.documents.get(settingsFile)?.shikiTheme, "nord");
    assert.deepEqual(panel.shown, panelValuesFor(codePreviewSettings));
    setCodePreviewSettings(defaultCodePreviewSettings);
  },
);

effectTest("selecting the value a stale panel already shows still saves it", function* () {
  setCodePreviewSettings(defaultCodePreviewSettings);
  const fake = makeInMemoryDocuments();
  const service = yield* buildSettingsService(fake);
  const loaded = yield* service.load(nextSettingsAdmission());
  const panel = gatedPanelSaves(service);
  // Another session changes the theme while this panel still shows the one it opened with.
  yield* service
    .save({ ...loaded, shikiTheme: "nord" }, nextSettingsAdmission(), { previous: loaded })
    .pipe(Effect.orDie);

  panel.model.onChange("shikiTheme", loaded.shikiTheme, panel.list);
  yield* panel.complete(0);
  assert.equal(codePreviewSettings.shikiTheme, loaded.shikiTheme);
  assert.notEqual(fake.documents.get(settingsFile)?.shikiTheme, "nord");
  assert.deepEqual(panel.shown, panelValuesFor(codePreviewSettings));
  setCodePreviewSettings(defaultCodePreviewSettings);
});
