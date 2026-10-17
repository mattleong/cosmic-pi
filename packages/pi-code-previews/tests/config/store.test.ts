import assert from "node:assert/strict";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { SettingsList } from "@earendil-works/pi-tui";
import type { JsonObject } from "pi-cosmic-core";
import { deferredPromise, temporaryDirectory } from "pi-cosmic-core/testing";
import { afterEach } from "vitest";
import { effectTest, step } from "../support/effect-test";
import { inertScheduler } from "../support/renderer-host";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../../src/application/capability";
import { nextSettingsAdmission, withSettingsCoordinator } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { loadCodePreviewSettings } from "../../index";
import { codePreviewApplicationLayer } from "../../src/layer";
import { runOneShotSettingsEffect } from "../../src/boundary/settings-one-shot";
import {
  CodePreviewSettingsService,
  queueSettingsReset,
  queueSettingsSave,
  type LoadSettingsOptions,
} from "../../src/config/store";
import type { CodePreviewSettings } from "../../src/config/schema";
import { createCodePreviewSettingsModel } from "../../src/settings/panel";

const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdir, readFile, writeFile } = nodeFsModule.promises;
const dirname = nodePathModule.dirname.bind(nodePathModule);
const join = nodePathModule.join.bind(nodePathModule);

const processEnv: NodeJS.ProcessEnv = process.env;

const loadSettingsFromDisk = (options: LoadSettingsOptions = {}) =>
  step(() =>
    runOneShotSettingsEffect(
      CodePreviewSettingsService.use((service) => service.load(nextSettingsAdmission(), options)),
    ),
  );

const saveSettingsToDisk = (settings: CodePreviewSettings, options?: LoadSettingsOptions) =>
  step(() => queueSettingsSave(settings, options));

const settingsRoots = (prefix: string) =>
  temporaryDirectory(prefix).pipe(
    Effect.map((root) => {
      const roots = {
        root,
        home: join(root, "home"),
        agentDir: join(root, "agent"),
        project: join(root, "project"),
      };
      processEnv.HOME = roots.home;
      processEnv.PI_CODING_AGENT_DIR = roots.agentDir;
      return roots;
    }),
  );

const installRunOnlyCapability = (run: CodePreviewSessionCapability["run"]) =>
  installCodePreviewSessionCapability({ run, ...inertScheduler });

const decodeSavedDocument = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);

const readSavedDocument = (path: string) =>
  step(() => readFile(path, "utf8").then(decodeSavedDocument));

const loadPreviewSettings = (project: string, trusted?: boolean) =>
  step(() => loadCodePreviewSettings(project, trusted));

const originalPiCodingAgentDir = processEnv.PI_CODING_AGENT_DIR;
const originalHome = processEnv.HOME;

afterEach(() => {
  if (originalPiCodingAgentDir === undefined) delete processEnv.PI_CODING_AGENT_DIR;
  else processEnv.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  if (originalHome === undefined) delete processEnv.HOME;
  else processEnv.HOME = originalHome;
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
});

effectTest("saveSettingsToDisk and loadSettingsFromDisk respect PI_CODING_AGENT_DIR", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-settings-");

  yield* saveSettingsToDisk({
    ...defaultCodePreviewSettings,
    readCollapsedLines: 37,
    toolCallCollapsedStyle: "compact",
  });

  const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.equal(saved.readCollapsedLines, 37);
  assert.equal(saved.toolCallCollapsedStyle, "compact");

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 37);
  assert.equal(loaded?.toolCallCollapsedStyle, "compact");

  yield* saveSettingsToDisk(defaultCodePreviewSettings);
  const resetDocument = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.equal(Object.hasOwn(resetDocument, "toolCallCollapsedStyle"), false);
  const reset = yield* loadSettingsFromDisk();
  assert.equal(reset?.toolCallCollapsedStyle, "preview");
});

effectTest("concurrent queued saves publish in invocation order", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-concurrent-save-");
  const loaded = (yield* loadSettingsFromDisk()) ?? defaultCodePreviewSettings;
  const first = queueSettingsSave({ ...loaded, readCollapsedLines: 41 });
  const second = queueSettingsSave({ ...loaded, readCollapsedLines: 42 });
  yield* step(() => Promise.all([first, second]));
  const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.equal(saved.readCollapsedLines, 42);
});

effectTest("rapid panel edits preserve fields merged from an external settings edit", function* () {
  const { agentDir, project } = yield* settingsRoots("pi-code-previews-panel-merge-");
  const file = join(agentDir, "code-previews.json");
  yield* writeJson(file, { shikiTheme: "github-dark", readCollapsedLines: 17 });
  const runtime = ManagedRuntime.make(codePreviewApplicationLayer);
  yield* Effect.addFinalizer(() => runtime.disposeEffect);
  installRunOnlyCapability((effect, signal) => runtime.runPromise(effect, { signal }));
  yield* loadPreviewSettings(project, true);
  yield* writeJson(file, { shikiTheme: "github-light", readCollapsedLines: 17 });

  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const blocked = runtime.runPromise(
    withSettingsCoordinator(nextSettingsAdmission(), () =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ),
  );
  yield* Deferred.await(started);
  const saves: Promise<void>[] = [];
  const model = createCodePreviewSettingsModel({
    loadOptions: { projectCwd: project, projectTrusted: true },
    notify: () => undefined,
    done: () => undefined,
    effects: {
      queueSave: (...args) => {
        const save = queueSettingsSave(...args);
        saves.push(save);
        return save;
      },
      queueReset: queueSettingsReset,
      initializeSyntax: () => Promise.resolve(),
    },
  });
  const list = new SettingsList(
    model.items,
    10,
    {
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      cursor: ">",
      hint: (text) => text,
    },
    () => undefined,
    () => undefined,
  );
  model.onChange("readCollapsedLines", "40", list);
  model.onChange("readLineNumbers", "off", list);
  yield* Deferred.succeed(release, undefined);
  yield* step(() => Promise.all([blocked, ...saves]));

  const committed = yield* readSavedDocument(file);
  assert.equal(committed.shikiTheme, "github-light");
  assert.equal(committed.readCollapsedLines, 40);
  assert.equal(committed.readLineNumbers, false);
  assert.equal(codePreviewSettings.shikiTheme, "github-light");
});

effectTest("loadSettingsFromDisk merges only current locations in precedence order", function* () {
  const { home, agentDir, project } = yield* settingsRoots("pi-code-previews-precedence-");

  yield* writeJson(join(home, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 11, writeCollapsedLines: 21, writeContentPreview: false },
  });
  yield* writeJson(join(home, ".pi", "agent", "settings.json"), {
    codePreview: { readCollapsedLines: 12, editDiffPreview: false, grepCollapsedLines: 22 },
  });
  yield* writeJson(join(home, ".pi", "agent", "code-previews.json"), {
    readCollapsedLines: 15,
    bashResultPreview: false,
  });
  yield* writeJson(join(agentDir, "settings.json"), {
    codePreview: { readCollapsedLines: 13, findResultPreview: false },
  });
  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 14, lsResultPreview: false },
  });
  yield* writeJson(join(agentDir, "code-previews.json"), {
    readCollapsedLines: 16,
    pathListCollapsedLines: 44,
    lsResultPreview: "invalid",
  });

  const loaded = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.equal(loaded.readCollapsedLines, 16);
  assert.equal(loaded.findResultPreview, false);
  assert.equal(loaded.lsResultPreview, false);
  assert.equal(loaded.pathListCollapsedLines, 44);
  assert.equal(loaded?.writeCollapsedLines, defaultCodePreviewSettings.writeCollapsedLines);
  assert.equal(loaded?.writeContentPreview, defaultCodePreviewSettings.writeContentPreview);
  assert.equal(loaded?.editDiffPreview, defaultCodePreviewSettings.editDiffPreview);
  assert.equal(loaded?.grepCollapsedLines, defaultCodePreviewSettings.grepCollapsedLines);
  assert.equal(loaded?.bashResultPreview, defaultCodePreviewSettings.bashResultPreview);
  const untrusted = yield* loadPreviewSettings(project);
  assert.equal(untrusted.lsResultPreview, defaultCodePreviewSettings.lsResultPreview);
  assert.equal(untrusted.findResultPreview, false);
});

const globalOverrideCases = [
  {
    name: "saving a global change does not copy project defaults into other projects",
    existing: undefined,
    saved: { shikiTheme: "github-dark" },
    secondRead: 22,
  },
];

for (const { name, existing, saved, secondRead } of globalOverrideCases)
  effectTest(name, function* () {
    const { root, agentDir, project } = yield* settingsRoots("pi-code-previews-global-overrides-");
    const secondProject = join(root, "second");
    yield* writeJson(join(project, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 77 },
    });
    yield* writeJson(join(secondProject, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 22 },
    });
    if (existing) yield* writeJson(join(agentDir, "code-previews.json"), existing);

    const first = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
    assert.ok(first);
    yield* saveSettingsToDisk(
      { ...first, shikiTheme: "github-dark" },
      { projectCwd: project, projectTrusted: true },
    );

    assert.deepEqual(yield* readSavedDocument(join(agentDir, "code-previews.json")), saved);
    const second = yield* loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
    assert.equal(second?.readCollapsedLines, secondRead);
    assert.equal(second?.shikiTheme, "github-dark");
  });

effectTest("an older live fallback cannot replace a newer successful publication", function* () {
  const { agentDir, project } = yield* settingsRoots("pi-code-previews-stale-fallback-");
  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 11 });

  const liveFailure = deferredPromise<never>();
  installRunOnlyCapability(() => liveFailure.promise);
  const oldSignal = new AbortController().signal;
  const older = loadCodePreviewSettings(project, true, oldSignal);
  clearCodePreviewSessionCapability();

  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 22 });
  const newer = yield* loadPreviewSettings(project, true);
  assert.equal(newer.readCollapsedLines, 22);
  assert.equal(codePreviewSettings.readCollapsedLines, 22);

  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 11 });
  liveFailure.reject(new Error("session replaced"));
  const staleResult = yield* step(() => older);
  assert.equal(staleResult.readCollapsedLines, 11);
  assert.equal(codePreviewSettings.readCollapsedLines, 22);
});

effectTest(
  "a queued settings call can be cancelled before its coordinator work starts",
  function* () {
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const first = runOneShotSettingsEffect(
      withSettingsCoordinator(nextSettingsAdmission(), () =>
        Effect.suspend(() => {
          Deferred.doneUnsafe(started, Effect.void);
          return Deferred.await(release);
        }),
      ),
    );
    yield* Deferred.await(started);

    let secondRan = false;
    const controller = new AbortController();
    const second = runOneShotSettingsEffect(
      withSettingsCoordinator(nextSettingsAdmission(), () =>
        Effect.sync(() => {
          secondRan = true;
        }),
      ),
      controller.signal,
    );
    controller.abort();
    yield* step(() => assert.rejects(second));
    Deferred.doneUnsafe(release, Effect.void);
    yield* step(() => first);
    assert.equal(secondRan, false);
  },
);

effectTest(
  "an aborted session settings load does not retry through the one-shot runtime",
  function* () {
    const { project } = yield* settingsRoots("pi-code-previews-aborted-bootstrap-");
    yield* writeJson(join(project, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 31 },
    });

    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;
    installRunOnlyCapability((_effect, signal) => {
      receivedSignal = signal;
      return Promise.reject(new Error("session startup was interrupted"));
    });
    yield* step(() => assert.rejects(loadCodePreviewSettings(project, true, controller.signal)));
    assert.equal(receivedSignal, controller.signal);
  },
);

function writeJson(path: string, data: JsonObject): Effect.Effect<void> {
  return step(() =>
    mkdir(dirname(path), { recursive: true }).then(() =>
      writeFile(path, `${JSON.stringify(data)}\n`, "utf8"),
    ),
  );
}
