// Explicit test entry-point Effects drive the real settings store boundaries.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import { effectTest, step } from "../support/effect-test";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { makeSettingsAdmission, withSettingsCoordinator } from "../../src/config/coordinator";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { nestedCodePreviewSettings } from "../../src/config/document-store";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { loadCodePreviewSettings } from "../../index";
import {
  cleanupTestTempDirectories,
  createTestTempDirectory,
} from "../../src/testing/temp-directories";
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

const makeTempDirectory = (prefix: string) => step(() => createTestTempDirectory(prefix));

const makeDirectory = (path: string) => step(() => mkdir(path, { recursive: true }));

const readSavedDocument = (path: string) =>
  step(() => readFile(path, "utf8").then((contents) => JSON.parse(contents)));

const queueSettingsSaveEffect = (settings: CodePreviewSettings, options?: LoadSettingsOptions) =>
  step(() => queueSettingsSave(settings, options));

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
  const configDir = yield* makeTempDirectory("pi-code-previews-settings-");
  processEnv.PI_CODING_AGENT_DIR = configDir;

  yield* saveSettingsToDisk({ ...defaultCodePreviewSettings, readCollapsedLines: 37 });

  const saved = yield* readSavedDocument(join(configDir, "code-previews.json"));
  assert.equal(saved.readCollapsedLines, 37);

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 37);
});

effectTest(
  "legacy prefixed and nested shapes in code-previews.json are ignored, not migrated",
  function* () {
    const root = yield* makeTempDirectory("pi-code-previews-legacy-shapes-");
    processEnv.PI_CODING_AGENT_DIR = root;
    yield* writeJson(join(root, "code-previews.json"), {
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
  const root = yield* makeTempDirectory("pi-code-previews-nested-only-");
  const agentDir = join(root, "agent");
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* writeJson(join(agentDir, "settings.json"), {
    readCollapsedLines: 55,
    codePreviewReadCollapsedLines: 56,
    codePreview: { readCollapsedLines: 21 },
  });

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 21);
});

effectTest(
  "saving preserves unknown root fields and legacy blocks without migrating them",
  function* () {
    const root = yield* makeTempDirectory("pi-code-previews-unknown-");
    processEnv.PI_CODING_AGENT_DIR = root;
    yield* writeJson(join(root, "code-previews.json"), {
      owner: "keep",
      codePreview: { readCollapsedLines: 12, futureSetting: { enabled: true } },
      readCollapsedLines: 14,
    });
    const loaded = yield* loadSettingsFromDisk();
    assert.ok(loaded);
    assert.equal(loaded.readCollapsedLines, 14);
    yield* saveSettingsToDisk({ ...loaded, readCollapsedLines: 20 });
    const saved = yield* readSavedDocument(join(root, "code-previews.json"));
    assert.equal(saved.owner, "keep");
    assert.equal(saved.readCollapsedLines, 20);
    // The legacy nested block is an unknown root field: preserved verbatim, never read or rewritten.
    assert.deepEqual(saved.codePreview, {
      readCollapsedLines: 12,
      futureSetting: { enabled: true },
    });
  },
);

effectTest("concurrent queued saves publish in invocation order", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-concurrent-save-");
  processEnv.PI_CODING_AGENT_DIR = root;
  const loaded = (yield* loadSettingsFromDisk()) ?? defaultCodePreviewSettings;
  const first = queueSettingsSave({ ...loaded, readCollapsedLines: 41 });
  const second = queueSettingsSave({ ...loaded, readCollapsedLines: 42 });
  yield* step(() => Promise.all([first, second]));
  const saved = yield* readSavedDocument(join(root, "code-previews.json"));
  assert.equal(saved.readCollapsedLines, 42);
});

effectTest("loadSettingsFromDisk merges only current locations in precedence order", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-precedence-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* makeDirectory(join(home, ".pi", "agent"));
  yield* makeDirectory(agentDir);
  yield* makeDirectory(join(project, ".pi"));

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
  "saving a global change does not copy project defaults into other projects",
  function* () {
    const root = yield* makeTempDirectory("pi-code-previews-global-overrides-");
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const firstProject = join(root, "first");
    const secondProject = join(root, "second");
    processEnv.HOME = home;
    processEnv.PI_CODING_AGENT_DIR = agentDir;

    yield* writeJson(join(firstProject, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 77 },
    });
    yield* writeJson(join(secondProject, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 22 },
    });

    const first = yield* loadSettingsFromDisk({ projectCwd: firstProject, projectTrusted: true });
    assert.ok(first);
    yield* saveSettingsToDisk(
      { ...first, shikiTheme: "github-dark" },
      { projectCwd: firstProject, projectTrusted: true },
    );

    const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
    assert.deepEqual(saved, { shikiTheme: "github-dark" });
    const second = yield* loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
    assert.equal(second?.readCollapsedLines, 22);
    assert.equal(second?.shikiTheme, "github-dark");
  },
);

effectTest("idle queued saves retain trusted project baselines", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-idle-project-save-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;

  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  const loaded = yield* loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.ok(loaded);

  yield* queueSettingsSaveEffect(
    { ...loaded, shikiTheme: "github-dark" },
    { projectCwd: project, projectTrusted: true },
  );

  const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.deepEqual(saved, { shikiTheme: "github-dark" });
});

effectTest("saving an unrelated change preserves existing explicit global overrides", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-preserve-overrides-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;

  yield* writeJson(join(firstProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  yield* writeJson(join(secondProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 22 },
  });
  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 77 });

  const first = yield* loadSettingsFromDisk({ projectCwd: firstProject, projectTrusted: true });
  assert.ok(first);
  yield* saveSettingsToDisk(
    { ...first, shikiTheme: "github-dark" },
    { projectCwd: firstProject, projectTrusted: true },
  );

  const saved = yield* readSavedDocument(join(agentDir, "code-previews.json"));
  assert.deepEqual(saved, { readCollapsedLines: 77, shikiTheme: "github-dark" });
  const second = yield* loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
  assert.equal(second?.readCollapsedLines, 77);
});

effectTest("loadSettingsFromDisk uses process cwd when project cwd is omitted", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-cwd-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* makeDirectory(join(home, ".pi", "agent"));
  yield* makeDirectory(agentDir);
  yield* makeDirectory(join(project, ".pi"));
  process.chdir(project);

  yield* writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 23 },
  });

  const loaded = yield* loadSettingsFromDisk({ projectTrusted: true });
  assert.equal(loaded?.readCollapsedLines, 23);
});

effectTest("loadSettingsFromDisk uses explicit project cwd instead of process cwd", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-project-cwd-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const targetProject = join(root, "target");
  const otherProject = join(root, "other");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* makeDirectory(join(home, ".pi", "agent"));
  yield* makeDirectory(agentDir);
  yield* makeDirectory(join(targetProject, ".pi"));
  yield* makeDirectory(join(otherProject, ".pi"));
  process.chdir(otherProject);

  yield* writeJson(join(targetProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 24 },
  });
  yield* writeJson(join(otherProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 99, writeCollapsedLines: 88 },
  });

  const loaded = yield* loadSettingsFromDisk({
    projectCwd: targetProject,
    projectTrusted: true,
  });
  assert.equal(loaded?.readCollapsedLines, 24);
  assert.equal(loaded?.writeCollapsedLines, defaultCodePreviewSettings.writeCollapsedLines);
});

effectTest(
  "loadCodePreviewSettings only reads project settings when the project is trusted",
  function* () {
    const root = yield* makeTempDirectory("pi-code-previews-project-trust-");
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    processEnv.HOME = home;
    processEnv.PI_CODING_AGENT_DIR = agentDir;

    yield* writeJson(join(agentDir, "settings.json"), {
      codePreview: { readCollapsedLines: 31 },
    });
    yield* writeJson(join(project, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 99 },
    });

    const untrusted = yield* loadPreviewSettings(project);
    assert.equal(untrusted.readCollapsedLines, 31);

    const trusted = yield* loadPreviewSettings(project, true);
    assert.equal(trusted.readCollapsedLines, 99);
  },
);

effectTest("deduplicated public loads return isolated settings and tools clones", function* () {
  const loadResult = Deferred.makeUnsafe<CodePreviewSettings>();
  const pending = Effect.runPromise(Deferred.await(loadResult));
  let runs = 0;
  installCodePreviewSessionCapability({
    run: <A>() => {
      runs++;
      // SAFETY: This fixture resolves with the settings value requested by both load Effects.
      return pending as Promise<A>;
    },
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });

  const firstLoad = loadCodePreviewSettings("/project", true);
  const secondLoad = loadCodePreviewSettings("/project", true);
  Deferred.doneUnsafe(
    loadResult,
    Effect.succeed({
      ...defaultCodePreviewSettings,
      readCollapsedLines: 31,
      tools: [...defaultCodePreviewSettings.tools],
    }),
  );
  const [first, second] = yield* step(() => Promise.all([firstLoad, secondLoad]));

  assert.equal(runs, 1);
  assert.notEqual(first, second);
  assert.notEqual(first.tools, second.tools);
  first.readCollapsedLines = 99;
  first.tools.length = 0;
  assert.equal(second.readCollapsedLines, 31);
  assert.deepEqual(second.tools, defaultCodePreviewSettings.tools);
});

effectTest(
  "loadCodePreviewSettings falls back when a replaced session capability rejects",
  function* () {
    const root = yield* makeTempDirectory("pi-code-previews-replaced-bootstrap-");
    const home = join(root, "home");
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    processEnv.HOME = home;
    processEnv.PI_CODING_AGENT_DIR = agentDir;
    yield* writeJson(join(project, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 31 },
    });

    installCodePreviewSessionCapability({
      run: () => Promise.reject(new Error("session replaced")),
      defer: () => () => undefined,
      schedule: () => () => undefined,
    });
    try {
      const loaded = yield* loadPreviewSettings(project, true);
      assert.equal(loaded.readCollapsedLines, 31);
    } finally {
      clearCodePreviewSessionCapability();
    }
  },
);

effectTest("an older live fallback cannot replace a newer successful publication", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-stale-fallback-");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 11 });

  const rejectLiveAttempt = Deferred.makeUnsafe<void>();
  const liveFailure = Effect.runPromise(Deferred.await(rejectLiveAttempt)).then(() => {
    throw new Error("session replaced");
  });
  installCodePreviewSessionCapability({
    run: <A>() => {
      // SAFETY: This host fixture rejects every requested Effect with the same replacement failure.
      return liveFailure as Promise<A>;
    },
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });
  const oldSignal = new AbortController().signal;
  const older = loadCodePreviewSettings(project, true, oldSignal);
  clearCodePreviewSessionCapability();

  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 22 });
  const newer = yield* loadPreviewSettings(project, true);
  assert.equal(newer.readCollapsedLines, 22);
  assert.equal(codePreviewSettings.readCollapsedLines, 22);

  yield* writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 11 });
  Deferred.doneUnsafe(rejectLiveAttempt, Effect.void);
  const staleResult = yield* step(() => older);
  assert.equal(staleResult.readCollapsedLines, 11);
  assert.equal(codePreviewSettings.readCollapsedLines, 22);
});

effectTest("the one-shot settings boundary forwards cancellation to Effect", function* () {
  const controller = new AbortController();
  const pending = runOneShotSettingsEffect(Effect.never, controller.signal);
  controller.abort();
  yield* step(() => assert.rejects(pending));
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
    const root = yield* makeTempDirectory("pi-code-previews-aborted-bootstrap-");
    const project = join(root, "project");
    yield* writeJson(join(project, ".pi", "settings.json"), {
      codePreview: { readCollapsedLines: 31 },
    });

    const controller = new AbortController();
    controller.abort();
    let receivedSignal: AbortSignal | undefined;
    installCodePreviewSessionCapability({
      run: (_effect, signal) => {
        receivedSignal = signal;
        return Promise.reject(new Error("session startup was interrupted"));
      },
      defer: () => () => undefined,
      schedule: () => () => undefined,
    });
    try {
      yield* step(() => assert.rejects(loadCodePreviewSettings(project, true, controller.signal)));
      assert.equal(receivedSignal, controller.signal);
    } finally {
      clearCodePreviewSessionCapability();
    }
  },
);

effectTest("loadCodePreviewSettings resets to defaults when no settings files exist", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-no-settings-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  processEnv.HOME = home;
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* makeDirectory(join(home, ".pi", "agent"));
  yield* makeDirectory(agentDir);
  yield* makeDirectory(project);

  setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 77 });

  const loaded = yield* loadPreviewSettings(project);
  assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(
    codePreviewSettings.readCollapsedLines,
    defaultCodePreviewSettings.readCollapsedLines,
  );
});

effectTest("loadSettingsFromDisk skips invalid JSON and continues", function* () {
  const root = yield* makeTempDirectory("pi-code-previews-invalid-settings-");
  const agentDir = join(root, "agent");
  processEnv.PI_CODING_AGENT_DIR = agentDir;
  yield* makeDirectory(agentDir);
  yield* step(() => writeFile(join(agentDir, "settings.json"), "{invalid", "utf8"));
  yield* writeJson(join(agentDir, "code-previews.json"), { grepCollapsedLines: 31 });

  const loaded = yield* loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(loaded?.grepCollapsedLines, 31);
});

function writeJson<DataInput>(path: string, data: DataInput): Effect.Effect<void> {
  return step(() =>
    mkdir(dirname(path), { recursive: true }).then(() =>
      writeFile(path, `${JSON.stringify(data)}\n`, "utf8"),
    ),
  );
}
