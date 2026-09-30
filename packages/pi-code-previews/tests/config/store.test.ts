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
  loadCodePreviewStartupSettings,
  queueSettingsSave,
  queueStartupSettingsSave,
  type LoadSettingsOptions,
} from "../../src/config/store";
import type { CodePreviewSettings, CodePreviewStartupSettings } from "../../src/config/schema";

// Raw Node builtin access for test scaffolding, mirroring pi-cosmic-core's platform boundary.
const nodeFsModule = process.getBuiltinModule("node:fs");
const nodePathModule = process.getBuiltinModule("node:path");
if (!nodeFsModule || !nodePathModule) throw new Error("Node fs/path builtins are unavailable.");
const { mkdir, readFile, rename, writeFile } = nodeFsModule.promises;
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
const originalCollapsedStyle = processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE;
const originalNativeMcp = processEnv.CODE_PREVIEW_NATIVE_MCP;
const originalCwd = process.cwd();

afterEach(() => {
  if (originalPiCodingAgentDir === undefined) delete processEnv.PI_CODING_AGENT_DIR;
  else processEnv.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  if (originalHome === undefined) delete processEnv.HOME;
  else processEnv.HOME = originalHome;
  if (originalCollapsedStyle === undefined)
    delete processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE;
  else processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE = originalCollapsedStyle;
  if (originalNativeMcp === undefined) delete processEnv.CODE_PREVIEW_NATIVE_MCP;
  else processEnv.CODE_PREVIEW_NATIVE_MCP = originalNativeMcp;
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
  delete processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE;

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

effectTest(
  "compact style follows environment, trusted baselines, and global overrides",
  function* () {
    const { agentDir, project } = yield* settingsRoots("pi-code-previews-compact-precedence-");
    processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE = "compact";

    const environment = yield* loadPreviewSettings(project);
    assert.equal(environment.toolCallCollapsedStyle, "compact");

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
  },
);

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
  delete processEnv.CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE;
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

const nativeMcpOptIn = () =>
  step(() => loadCodePreviewStartupSettings()).pipe(
    Effect.map((startup) => startup.nativeMcpPreviews),
  );

effectTest("the native MCP startup opt-in is global-only and defaults off", function* () {
  const { agentDir, project } = yield* settingsRoots("pi-code-previews-startup-");
  delete processEnv.CODE_PREVIEW_NATIVE_MCP;
  assert.equal(yield* nativeMcpOptIn(), false);

  process.chdir(yield* step(() => mkdir(project, { recursive: true }).then(() => project)));
  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { nativeMcpPreviews: true },
  });
  assert.equal(yield* nativeMcpOptIn(), false, "trusted-project settings never opt in");

  yield* writeJson(join(agentDir, "settings.json"), { codePreview: { nativeMcpPreviews: true } });
  assert.equal(yield* nativeMcpOptIn(), true);
  yield* writeJson(join(agentDir, "code-previews.json"), { nativeMcpPreviews: false });
  assert.equal(yield* nativeMcpOptIn(), false, "the package document overrides settings.json");

  processEnv.CODE_PREVIEW_NATIVE_MCP = "on";
  yield* writeJson(join(agentDir, "code-previews.json"), {});
  yield* writeJson(join(agentDir, "settings.json"), {});
  assert.equal(yield* nativeMcpOptIn(), true, "the environment supplies only the default");
});

const failedOptIns: ReadonlyArray<readonly [string, string]> = [
  ["an invalid value", '{"nativeMcpPreviews":"yes"}'],
  ["unreadable JSON", "{invalid"],
];
for (const [label, contents] of failedOptIns)
  effectTest(`the native MCP startup opt-in fails closed on ${label}`, function* () {
    const { agentDir } = yield* settingsRoots("pi-code-previews-startup-invalid-");
    processEnv.CODE_PREVIEW_NATIVE_MCP = "on";
    yield* writeJson(join(agentDir, "settings.json"), { codePreview: { nativeMcpPreviews: true } });
    yield* step(() => writeFile(join(agentDir, "code-previews.json"), contents, "utf8"));

    assert.equal(yield* nativeMcpOptIn(), false);
  });

effectTest("settings saves preserve the startup opt-in as an unknown root field", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-startup-save-");
  delete processEnv.CODE_PREVIEW_NATIVE_MCP;
  const path = join(agentDir, "code-previews.json");
  yield* writeJson(path, { nativeMcpPreviews: true, readCollapsedLines: 12 });

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(Object.hasOwn(loaded, "nativeMcpPreviews"), false);
  yield* saveSettingsToDisk({ ...loaded, readCollapsedLines: 30 });

  assert.deepEqual(yield* readSavedDocument(path), {
    nativeMcpPreviews: true,
    readCollapsedLines: 30,
  });
  assert.equal(yield* nativeMcpOptIn(), true);
});

const saveStartupWithAdmission = (
  settings: CodePreviewStartupSettings,
  admission: ReturnType<typeof makeSettingsAdmission>,
) =>
  step(() =>
    runOneShotSettingsEffect(
      CodePreviewSettingsService.use((service) => service.saveStartup(settings, admission)),
    ),
  );

effectTest(
  "startup edits write global overrides without changing previews, project files or MCP config",
  function* () {
    const { agentDir, project } = yield* settingsRoots("pi-code-previews-startup-edit-");
    const file = join(agentDir, "code-previews.json");
    const projectFile = join(project, ".pi", "settings.json");
    const mcpFile = join(agentDir, "mcp.json");
    const original = { readCollapsedLines: 12, futureSetting: { keep: true } };
    yield* writeJson(file, original);
    yield* writeJson(projectFile, { codePreview: { nativeMcpPreviews: false } });
    yield* writeJson(mcpFile, { mcpServers: { docs: { command: "fixture", enabled: true } } });
    const preview = codePreviewSettings;
    yield* step(() => queueStartupSettingsSave({ nativeMcpPreviews: true }));
    assert.deepEqual(yield* readSavedDocument(file), { ...original, nativeMcpPreviews: true });
    assert.deepEqual(yield* readSavedDocument(projectFile), {
      codePreview: { nativeMcpPreviews: false },
    });
    assert.deepEqual(yield* readSavedDocument(mcpFile), {
      mcpServers: { docs: { command: "fixture", enabled: true } },
    });
    assert.equal(codePreviewSettings, preview, "startup edits do not publish live preview changes");
    yield* step(() => queueStartupSettingsSave({ nativeMcpPreviews: false }));
    assert.equal(yield* nativeMcpOptIn(), false);
  },
);

effectTest(
  "startup and ordinary saves do not suppress each other's independently admitted edits",
  function* () {
    const { agentDir } = yield* settingsRoots("pi-code-previews-startup-currency-");
    const file = join(agentDir, "code-previews.json");
    yield* writeJson(file, { nativeMcpPreviews: false, readCollapsedLines: 12 });
    const ordinary = makeSettingsAdmission();
    yield* step(() => queueStartupSettingsSave({ nativeMcpPreviews: true }));
    yield* step(() =>
      runOneShotSettingsEffect(
        CodePreviewSettingsService.use((service) =>
          service.save({ ...defaultCodePreviewSettings, readCollapsedLines: 41 }, ordinary, {
            rehydrate: {},
          }),
        ),
      ),
    );
    assert.equal((yield* readSavedDocument(file)).readCollapsedLines, 41);
    assert.equal((yield* readSavedDocument(file)).nativeMcpPreviews, true);

    const startup = makeSettingsAdmission();
    yield* saveSettingsToDisk({ ...defaultCodePreviewSettings, readCollapsedLines: 54 });
    yield* saveStartupWithAdmission({ nativeMcpPreviews: false }, startup);
    assert.equal((yield* readSavedDocument(file)).nativeMcpPreviews, false);
    assert.equal((yield* readSavedDocument(file)).readCollapsedLines, 54);
  },
);

effectTest("a late older startup save cannot undo a newer successful startup edit", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-startup-stale-");
  const older = makeSettingsAdmission();
  yield* step(() => queueStartupSettingsSave({ nativeMcpPreviews: true }));
  const restored = yield* saveStartupWithAdmission({ nativeMcpPreviews: false }, older);
  assert.equal(restored.nativeMcpPreviews, true);
  assert.equal(
    (yield* readSavedDocument(join(agentDir, "code-previews.json"))).nativeMcpPreviews,
    true,
  );
});

effectTest("failed startup writes do not obsolete an earlier recoverable edit", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-startup-failure-");
  const file = join(agentDir, "code-previews.json");
  yield* step(() => mkdir(file, { recursive: true }));
  const earlier = makeSettingsAdmission();
  yield* step(() => assert.rejects(queueStartupSettingsSave({ nativeMcpPreviews: false })));
  yield* step(() => rename(file, join(agentDir, "failed-settings-directory")));
  yield* saveStartupWithAdmission({ nativeMcpPreviews: true }, earlier);
  assert.equal((yield* readSavedDocument(file)).nativeMcpPreviews, true);
});

effectTest("aborted startup edits leave the persisted setting unchanged", function* () {
  const { agentDir } = yield* settingsRoots("pi-code-previews-startup-abort-");
  const file = join(agentDir, "code-previews.json");
  yield* writeJson(file, { nativeMcpPreviews: true });
  const controller = new AbortController();
  controller.abort();
  yield* step(() =>
    assert.rejects(queueStartupSettingsSave({ nativeMcpPreviews: false }, controller.signal)),
  );
  assert.deepEqual(yield* readSavedDocument(file), { nativeMcpPreviews: true });
});

function writeJson<DataInput>(path: string, data: DataInput): Effect.Effect<void> {
  return step(() =>
    mkdir(dirname(path), { recursive: true }).then(() =>
      writeFile(path, `${JSON.stringify(data)}\n`, "utf8"),
    ),
  );
}
