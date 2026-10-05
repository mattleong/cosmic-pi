// Explicit test entry-point Effects drive the real settings store boundaries.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { deferredPromise } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import { effectTest, step } from "../support/effect-test";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  type CodePreviewSessionCapability,
} from "../../src/application/capability";
import { makeSettingsAdmission, withSettingsCoordinator } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { nestedCodePreviewSettings } from "../../src/config/document-store";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { loadCodePreviewSettings } from "../../index";
import { cleanupTestTempDirectories, createTestTempDirectory } from "../support/temp-directories";
import { runOneShotSettingsEffect } from "../../src/boundary/settings-one-shot";
import {
  CodePreviewSettingsService,
  getSettingsPath,
  queueSettingsSave,
  type LoadSettingsOptions,
} from "../../src/config/store";
import type { CodePreviewSettings } from "../../src/config/schema";

// Raw Node builtin access for test scaffolding, mirroring pi-cosmic-core's platform boundary.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdir, readFile, writeFile } = nodeFsModule.promises;
const { dirname, join } = nodePathModule;

// Mutating agent-directory and HOME slots is this suite's process-environment host boundary.
const processEnv: NodeJS.ProcessEnv = process.env;

/** Exercises the real settings service through its named one-shot boundary adapter. */
const loadSettingsFromDisk = (options: LoadSettingsOptions = {}) =>
  step(() =>
    runOneShotSettingsEffect(
      CodePreviewSettingsService.use((service) => service.load(makeSettingsAdmission(), options)),
    ),
  );

const saveSettingsToDisk = (settings: CodePreviewSettings, options: LoadSettingsOptions = {}) =>
  step(() =>
    runOneShotSettingsEffect(
      CodePreviewSettingsService.use((service) =>
        service.save(settings, makeSettingsAdmission(), { rehydrate: options }),
      ),
    ),
  );

/** Creates an isolated temp root and points HOME and Pi's agent directory inside it. */
const settingsRoots = (prefix: string) =>
  step(() => createTestTempDirectory(prefix)).pipe(
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
  installCodePreviewSessionCapability({
    run,
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });

const readSavedDocument = (path: string) =>
  step(() => readFile(path, "utf8").then((contents) => JSON.parse(contents)));

const loadPreviewSettings = (project: string, trusted?: boolean) =>
  step(() => loadCodePreviewSettings(project, trusted));

const originalPiCodingAgentDir = processEnv.PI_CODING_AGENT_DIR;
const originalHome = processEnv.HOME;
const originalCwd = process.cwd();

afterEach(() => {
  if (originalPiCodingAgentDir === undefined) delete processEnv.PI_CODING_AGENT_DIR;
  else processEnv.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  if (originalHome === undefined) delete processEnv.HOME;
  else processEnv.HOME = originalHome;
  process.chdir(originalCwd);
  clearCodePreviewSessionCapability();
  setCodePreviewSettings(defaultCodePreviewSettings);
  return cleanupTestTempDirectories();
});

test("getSettingsPath uses Pi's agent directory resolution", () => {
  processEnv.PI_CODING_AGENT_DIR = join("~", ".config", "pi");

  assert.equal(getSettingsPath(), join(homedir(), ".config", "pi", "code-previews.json"));
});

const nestedSettingsCases: ReadonlyArray<readonly [string, JsonValue, JsonObject]> = [
  [
    "object",
    { readCollapsedLines: 21, futureSetting: { enabled: true } },
    {
      readCollapsedLines: 21,
      futureSetting: { enabled: true },
    },
  ],
  ["null", null, {}],
  ["array", [{ readCollapsedLines: 21 }], {}],
  ["string", "21", {}],
  ["number", 21, {}],
  ["boolean", true, {}],
];

test.each(nestedSettingsCases)(
  "settings.json accepts only a nested JSON object: %s",
  (_label, nested, expected) => {
    assert.deepEqual(nestedCodePreviewSettings({ codePreview: nested }), expected);
  },
);

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

effectTest(
  "legacy prefixed and nested shapes in code-previews.json are ignored, not migrated",
  function* () {
    const { agentDir } = yield* settingsRoots("pi-code-previews-legacy-shapes-");
    yield* writeJson(join(agentDir, "code-previews.json"), {
      codePreviewReadCollapsedLines: 30,
      codePreview: { readCollapsedLines: 12 },
      toolCallBackground: true,
      tools: "bash,write",
      grepCollapsedLines: 44,
    });

    const loaded = yield* loadSettingsFromDisk();
    assert.ok(loaded);
    // Only flat current keys with current value shapes apply; everything else keeps defaults.
    assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
    assert.equal(loaded.toolCallBackground, defaultCodePreviewSettings.toolCallBackground);
    assert.deepEqual(loaded.tools, [...defaultCodePreviewSettings.tools]);
    assert.equal(loaded.grepCollapsedLines, 44);
  },
);

effectTest("settings.json baselines accept only the nested codePreview object", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-nested-only-");
  yield* writeJson(join(agentDir, "settings.json"), {
    readCollapsedLines: 55,
    codePreviewReadCollapsedLines: 56,
    codePreview: { readCollapsedLines: 21 },
  });

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 21);
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

effectTest("loadSettingsFromDisk merges only current locations in precedence order", function* () {
  const { home, agentDir, project } = yield* settingsRoots("pi-code-previews-precedence-");

  // Legacy HOME-derived locations must be ignored entirely, never merged or migrated.
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
  });

  const loaded = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.equal(loaded?.readCollapsedLines, 16);
  assert.equal(loaded?.findResultPreview, false);
  assert.equal(loaded?.lsResultPreview, false);
  assert.equal(loaded?.pathListCollapsedLines, 44);
  // Values that existed only in legacy locations stay at their defaults.
  assert.equal(loaded?.writeCollapsedLines, defaultCodePreviewSettings.writeCollapsedLines);
  assert.equal(loaded?.writeContentPreview, defaultCodePreviewSettings.writeContentPreview);
  assert.equal(loaded?.editDiffPreview, defaultCodePreviewSettings.editDiffPreview);
  assert.equal(loaded?.grepCollapsedLines, defaultCodePreviewSettings.grepCollapsedLines);
  assert.equal(loaded?.bashResultPreview, defaultCodePreviewSettings.bashResultPreview);
});

effectTest("compact style follows defaults, trusted baselines, and global overrides", function* () {
  const { agentDir, project } = yield* settingsRoots("pi-code-previews-compact-precedence-");

  const defaults = yield* loadPreviewSettings(project);
  assert.equal(defaults.toolCallCollapsedStyle, "preview");

  yield* writeJson(join(agentDir, "settings.json"), {
    codePreview: { toolCallCollapsedStyle: "preview" },
  });
  const global = yield* loadPreviewSettings(project);
  assert.equal(global.toolCallCollapsedStyle, "preview");

  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { toolCallCollapsedStyle: "compact" },
  });
  const untrusted = yield* loadPreviewSettings(project);
  assert.equal(untrusted.toolCallCollapsedStyle, "preview");
  const trusted = yield* loadPreviewSettings(project, true);
  assert.equal(trusted.toolCallCollapsedStyle, "compact");

  yield* writeJson(join(agentDir, "code-previews.json"), { toolCallCollapsedStyle: "preview" });
  const override = yield* loadPreviewSettings(project, true);
  assert.equal(override.toolCallCollapsedStyle, "preview");

  yield* writeJson(join(agentDir, "code-previews.json"), {
    toolCallCollapsedStyle: "invalid",
    readCollapsedLines: 29,
  });
  const recovered = yield* loadPreviewSettings(project, true);
  assert.equal(recovered.toolCallCollapsedStyle, "compact");
  assert.equal(recovered.readCollapsedLines, 29);
});

const globalOverrideCases = [
  {
    name: "saving a global change does not copy project defaults into other projects",
    existing: undefined,
    saved: { shikiTheme: "github-dark" },
    secondRead: 22,
  },
  {
    name: "saving an unrelated change preserves existing explicit global overrides",
    existing: { readCollapsedLines: 77 },
    saved: { readCollapsedLines: 77, shikiTheme: "github-dark" },
    secondRead: 77,
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

effectTest("idle queued saves retain trusted project baselines", function* () {
  const { agentDir, project } = yield* settingsRoots("pi-code-previews-idle-project-save-");
  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  const loaded = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.ok(loaded);

  yield* step(() =>
    queueSettingsSave(
      { ...loaded, shikiTheme: "github-dark" },
      { projectCwd: project, projectTrusted: true },
    ),
  );

  const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.deepEqual(saved, { shikiTheme: "github-dark" });
});

effectTest("loadSettingsFromDisk prefers explicit project cwd over process cwd", function* () {
  const { root, project } = yield* settingsRoots("pi-code-previews-project-cwd-");
  const otherProject = join(root, "other");
  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 24 },
  });
  yield* writeJson(join(otherProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 99, writeCollapsedLines: 88 },
  });
  process.chdir(otherProject);

  const fromProcessCwd = yield* loadSettingsFromDisk({ projectTrusted: true });
  assert.equal(fromProcessCwd?.readCollapsedLines, 99);
  const loaded = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.equal(loaded?.readCollapsedLines, 24);
  assert.equal(loaded?.writeCollapsedLines, defaultCodePreviewSettings.writeCollapsedLines);
});

effectTest("deduplicated public loads return isolated settings and tools clones", function* () {
  const load = deferredPromise<CodePreviewSettings>();
  let runs = 0;
  installRunOnlyCapability(<A>() => {
    runs++;
    // SAFETY: This fixture resolves with the settings value requested by both load Effects.
    return load.promise as Promise<A>;
  });

  const firstLoad = loadCodePreviewSettings("/project", true);
  const secondLoad = loadCodePreviewSettings("/project", true);
  load.resolve({
    ...defaultCodePreviewSettings,
    readCollapsedLines: 31,
    tools: [...defaultCodePreviewSettings.tools],
  });
  const [first, second] = yield* step(() => Promise.all([firstLoad, secondLoad]));

  assert.equal(runs, 1);
  assert.notEqual(first, second);
  assert.notEqual(first.tools, second.tools);
  first.readCollapsedLines = 99;
  first.tools.length = 0;
  assert.equal(second.readCollapsedLines, 31);
  assert.deepEqual(second.tools, defaultCodePreviewSettings.tools);
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
      withSettingsCoordinator(makeSettingsAdmission(), () =>
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
      withSettingsCoordinator(makeSettingsAdmission(), () =>
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

effectTest("loadCodePreviewSettings resets to defaults when no settings files exist", function* () {
  const { project } = yield* settingsRoots("pi-code-previews-no-settings-");
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    readCollapsedLines: 77,
    toolCallCollapsedStyle: "compact",
  });

  const loaded = yield* loadPreviewSettings(project);
  assert.equal(loaded.toolCallCollapsedStyle, "preview");
  assert.equal(codePreviewSettings.toolCallCollapsedStyle, "preview");
  assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(
    codePreviewSettings.readCollapsedLines,
    defaultCodePreviewSettings.readCollapsedLines,
  );
});

effectTest("loadSettingsFromDisk skips invalid JSON and continues", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-invalid-settings-");
  yield* writeJson(join(agentDir, "code-previews.json"), { grepCollapsedLines: 31 });
  yield* step(() => writeFile(join(agentDir, "settings.json"), "{invalid", "utf8"));

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(loaded?.grepCollapsedLines, 31);
});

effectTest("settings saves preserve retired fields as inert unknown root data", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-retired-field-save-");
  const path = join(agentDir, "code-previews.json");
  yield* writeJson(path, { nativeMcpPreviews: true, readCollapsedLines: 12 });

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(Object.hasOwn(loaded, "nativeMcpPreviews"), false);
  yield* saveSettingsToDisk({ ...loaded, readCollapsedLines: 30 });

  assert.deepEqual(yield* readSavedDocument(path), {
    nativeMcpPreviews: true,
    readCollapsedLines: 30,
  });
  yield* saveSettingsToDisk(defaultCodePreviewSettings);
  assert.deepEqual(yield* readSavedDocument(path), { nativeMcpPreviews: true });
});

function writeJson<DataInput>(path: string, data: DataInput): Effect.Effect<void> {
  return step(() =>
    mkdir(dirname(path), { recursive: true }).then(() =>
      writeFile(path, `${JSON.stringify(data)}\n`, "utf8"),
    ),
  );
}
