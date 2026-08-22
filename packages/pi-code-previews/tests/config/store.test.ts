// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "vitest";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { loadCodePreviewSettings } from "../../src/settings/bootstrap";
import {
  cleanupTestTempDirectories,
  createTestTempDirectory,
} from "../../src/testing/temp-directories";
import * as Effect from "effect/Effect";
import { runOneShotSettingsEffect } from "../../src/boundary/settings-one-shot";
import {
  CodePreviewSettingsService,
  getSettingsPath,
  queueSettingsSave,
  type LoadSettingsOptions,
} from "../../src/config/store";
import type { CodePreviewSettings } from "../../src/config/schema";

/** Exercises the real settings service through its named one-shot boundary adapter. */
const loadSettingsFromDisk = (options: LoadSettingsOptions = {}) =>
  runOneShotSettingsEffect(
    CodePreviewSettingsService.use((service) => service.loadFromDisk(options)),
  );

const saveSettingsToDisk = (settings: CodePreviewSettings, options: LoadSettingsOptions = {}) =>
  runOneShotSettingsEffect(
    CodePreviewSettingsService.use((service) =>
      service.loadFromDisk(options).pipe(Effect.andThen(service.save(settings))),
    ),
  );

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

afterEach(async () => {
  if (originalPiCodingAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiCodingAgentDir;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  process.chdir(originalCwd);
  setCodePreviewSettings(defaultCodePreviewSettings);
  await cleanupTestTempDirectories();
});

test("getSettingsPath uses Pi's agent directory resolution", () => {
  process.env.PI_CODING_AGENT_DIR = join("~", ".config", "pi");

  assert.equal(getSettingsPath(), join(homedir(), ".config", "pi", "code-previews.json"));
});

test("saveSettingsToDisk and loadSettingsFromDisk respect PI_CODING_AGENT_DIR", async () => {
  const configDir = await createTestTempDirectory("pi-code-previews-settings-");
  process.env.PI_CODING_AGENT_DIR = configDir;

  await saveSettingsToDisk({ ...defaultCodePreviewSettings, readCollapsedLines: 37 });

  const saved = JSON.parse(await readFile(join(configDir, "code-previews.json"), "utf8"));
  assert.equal(saved.readCollapsedLines, 37);

  const loaded = await loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 37);
});

test("legacy prefixed and nested shapes in code-previews.json are ignored, not migrated", async () => {
  const root = await createTestTempDirectory("pi-code-previews-legacy-shapes-");
  process.env.PI_CODING_AGENT_DIR = root;
  await writeJson(join(root, "code-previews.json"), {
    codePreviewReadCollapsedLines: 30,
    codePreview: { readCollapsedLines: 12 },
    toolCallBackground: true,
    tools: "bash,write",
    grepCollapsedLines: 44,
  });

  const loaded = await loadSettingsFromDisk();
  assert.ok(loaded);
  // Only flat current keys with current value shapes apply; everything else keeps defaults.
  assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(loaded.toolCallBackground, defaultCodePreviewSettings.toolCallBackground);
  assert.deepEqual(loaded.tools, [...defaultCodePreviewSettings.tools]);
  assert.equal(loaded.grepCollapsedLines, 44);
});

test("settings.json baselines accept only the nested codePreview object", async () => {
  const root = await createTestTempDirectory("pi-code-previews-nested-only-");
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeJson(join(agentDir, "settings.json"), {
    readCollapsedLines: 55,
    codePreviewReadCollapsedLines: 56,
    codePreview: { readCollapsedLines: 21 },
  });

  const loaded = await loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 21);
});

test("saving preserves unknown root fields and legacy blocks without migrating them", async () => {
  const root = await createTestTempDirectory("pi-code-previews-unknown-");
  process.env.PI_CODING_AGENT_DIR = root;
  await writeJson(join(root, "code-previews.json"), {
    owner: "keep",
    codePreview: { readCollapsedLines: 12, futureSetting: { enabled: true } },
    readCollapsedLines: 14,
  });
  const loaded = await loadSettingsFromDisk();
  assert.ok(loaded);
  assert.equal(loaded.readCollapsedLines, 14);
  await saveSettingsToDisk({ ...loaded, readCollapsedLines: 20 });
  const saved = JSON.parse(await readFile(join(root, "code-previews.json"), "utf8"));
  assert.equal(saved.owner, "keep");
  assert.equal(saved.readCollapsedLines, 20);
  // The legacy nested block is an unknown root field: preserved verbatim, never read or rewritten.
  assert.deepEqual(saved.codePreview, { readCollapsedLines: 12, futureSetting: { enabled: true } });
});

test("concurrent queued saves publish in invocation order", async () => {
  const root = await createTestTempDirectory("pi-code-previews-concurrent-save-");
  process.env.PI_CODING_AGENT_DIR = root;
  const loaded = (await loadSettingsFromDisk()) ?? defaultCodePreviewSettings;
  const first = queueSettingsSave({ ...loaded, readCollapsedLines: 41 });
  const second = queueSettingsSave({ ...loaded, readCollapsedLines: 42 });
  await Promise.all([first, second]);
  const saved = JSON.parse(await readFile(join(root, "code-previews.json"), "utf8"));
  assert.equal(saved.readCollapsedLines, 42);
});

test("loadSettingsFromDisk merges only current locations in precedence order", async () => {
  const root = await createTestTempDirectory("pi-code-previews-precedence-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });

  // Legacy HOME-derived locations must be ignored entirely, never merged or migrated.
  await writeJson(join(home, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 11, writeCollapsedLines: 21, writeContentPreview: false },
  });
  await writeJson(join(home, ".pi", "agent", "settings.json"), {
    codePreview: { readCollapsedLines: 12, editDiffPreview: false, grepCollapsedLines: 22 },
  });
  await writeJson(join(home, ".pi", "agent", "code-previews.json"), {
    readCollapsedLines: 15,
    bashResultPreview: false,
  });
  await writeJson(join(agentDir, "settings.json"), {
    codePreview: { readCollapsedLines: 13, findResultPreview: false },
  });
  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 14, lsResultPreview: false },
  });
  await writeJson(join(agentDir, "code-previews.json"), {
    readCollapsedLines: 16,
    pathListCollapsedLines: 44,
  });

  const loaded = await loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
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

test("saving a global change does not copy project defaults into other projects", async () => {
  const root = await createTestTempDirectory("pi-code-previews-global-overrides-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await writeJson(join(firstProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  await writeJson(join(secondProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 22 },
  });

  const first = await loadSettingsFromDisk({ projectCwd: firstProject, projectTrusted: true });
  assert.ok(first);
  await saveSettingsToDisk(
    { ...first, shikiTheme: "github-dark" },
    { projectCwd: firstProject, projectTrusted: true },
  );

  const saved = JSON.parse(await readFile(join(agentDir, "code-previews.json"), "utf8"));
  assert.deepEqual(saved, { shikiTheme: "github-dark" });
  const second = await loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
  assert.equal(second?.readCollapsedLines, 22);
  assert.equal(second?.shikiTheme, "github-dark");
});

test("idle queued saves retain trusted project baselines", async () => {
  const root = await createTestTempDirectory("pi-code-previews-idle-project-save-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  const loaded = await loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.ok(loaded);

  await queueSettingsSave(
    { ...loaded, shikiTheme: "github-dark" },
    { projectCwd: project, projectTrusted: true },
  );

  const saved = JSON.parse(await readFile(join(agentDir, "code-previews.json"), "utf8"));
  assert.deepEqual(saved, { shikiTheme: "github-dark" });
});

test("saving an unrelated change preserves existing explicit global overrides", async () => {
  const root = await createTestTempDirectory("pi-code-previews-preserve-overrides-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const firstProject = join(root, "first");
  const secondProject = join(root, "second");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await writeJson(join(firstProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 77 },
  });
  await writeJson(join(secondProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 22 },
  });
  await writeJson(join(agentDir, "code-previews.json"), { readCollapsedLines: 77 });

  const first = await loadSettingsFromDisk({ projectCwd: firstProject, projectTrusted: true });
  assert.ok(first);
  await saveSettingsToDisk(
    { ...first, shikiTheme: "github-dark" },
    { projectCwd: firstProject, projectTrusted: true },
  );

  const saved = JSON.parse(await readFile(join(agentDir, "code-previews.json"), "utf8"));
  assert.deepEqual(saved, { readCollapsedLines: 77, shikiTheme: "github-dark" });
  const second = await loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
  assert.equal(second?.readCollapsedLines, 77);
});

test("loadSettingsFromDisk uses process cwd when project cwd is omitted", async () => {
  const root = await createTestTempDirectory("pi-code-previews-cwd-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });
  process.chdir(project);

  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 23 },
  });

  const loaded = await loadSettingsFromDisk({ projectTrusted: true });
  assert.equal(loaded?.readCollapsedLines, 23);
});

test("loadSettingsFromDisk uses explicit project cwd instead of process cwd", async () => {
  const root = await createTestTempDirectory("pi-code-previews-project-cwd-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const targetProject = join(root, "target");
  const otherProject = join(root, "other");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(targetProject, ".pi"), { recursive: true });
  await mkdir(join(otherProject, ".pi"), { recursive: true });
  process.chdir(otherProject);

  await writeJson(join(targetProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 24 },
  });
  await writeJson(join(otherProject, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 99, writeCollapsedLines: 88 },
  });

  const loaded = await loadSettingsFromDisk({
    projectCwd: targetProject,
    projectTrusted: true,
  });
  assert.equal(loaded?.readCollapsedLines, 24);
  assert.equal(loaded?.writeCollapsedLines, defaultCodePreviewSettings.writeCollapsedLines);
});

test("loadCodePreviewSettings only reads project settings when the project is trusted", async () => {
  const root = await createTestTempDirectory("pi-code-previews-project-trust-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  await writeJson(join(agentDir, "settings.json"), {
    codePreview: { readCollapsedLines: 31 },
  });
  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 99 },
  });

  const untrusted = await loadCodePreviewSettings(project);
  assert.equal(untrusted.readCollapsedLines, 31);

  const trusted = await loadCodePreviewSettings(project, true);
  assert.equal(trusted.readCollapsedLines, 99);
});

test("loadCodePreviewSettings falls back when a replaced session capability rejects", async () => {
  const root = await createTestTempDirectory("pi-code-previews-replaced-bootstrap-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 31 },
  });

  const token = 991;
  installCodePreviewSessionCapability({
    token,
    run: () => Promise.reject(new Error("session replaced")),
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });
  try {
    const loaded = await loadCodePreviewSettings(project, true);
    assert.equal(loaded.readCollapsedLines, 31);
  } finally {
    clearCodePreviewSessionCapability(token);
  }
});

test("the one-shot settings boundary forwards cancellation to Effect", async () => {
  const controller = new AbortController();
  const pending = runOneShotSettingsEffect(Effect.never, controller.signal);
  controller.abort();
  await assert.rejects(pending);
});

test("a queued one-shot settings call can be cancelled before it acquires the permit", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseFirst!: () => void;
  const first = runOneShotSettingsEffect(
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve;
          markStarted();
        }),
    ),
  );
  await started;

  let secondRan = false;
  const controller = new AbortController();
  const second = runOneShotSettingsEffect(
    Effect.sync(() => {
      secondRan = true;
    }),
    controller.signal,
  );
  controller.abort();
  await assert.rejects(second);
  releaseFirst();
  await first;
  assert.equal(secondRan, false);
});

test("an aborted session settings load does not retry through the one-shot runtime", async () => {
  const root = await createTestTempDirectory("pi-code-previews-aborted-bootstrap-");
  const project = join(root, "project");
  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 31 },
  });

  const controller = new AbortController();
  controller.abort();
  let receivedSignal: AbortSignal | undefined;
  const token = 992;
  installCodePreviewSessionCapability({
    token,
    run: (_effect, signal) => {
      receivedSignal = signal;
      return Promise.reject(new Error("session startup was interrupted"));
    },
    defer: () => () => undefined,
    schedule: () => () => undefined,
  });
  try {
    await assert.rejects(loadCodePreviewSettings(project, true, controller.signal));
    assert.equal(receivedSignal, controller.signal);
  } finally {
    clearCodePreviewSessionCapability(token);
  }
});

test("loadCodePreviewSettings resets to defaults when no settings files exist", async () => {
  const root = await createTestTempDirectory("pi-code-previews-no-settings-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(project, { recursive: true });

  setCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 77 });

  const loaded = await loadCodePreviewSettings(project);
  assert.equal(loaded.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(
    codePreviewSettings.readCollapsedLines,
    defaultCodePreviewSettings.readCollapsedLines,
  );
});

test("loadSettingsFromDisk skips invalid JSON and continues", async () => {
  const root = await createTestTempDirectory("pi-code-previews-invalid-settings-");
  const agentDir = join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "settings.json"), "{invalid", "utf8");
  await writeJson(join(agentDir, "code-previews.json"), { grepCollapsedLines: 31 });

  const loaded = await loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, defaultCodePreviewSettings.readCollapsedLines);
  assert.equal(loaded?.grepCollapsedLines, 31);
});

async function writeJson<DataInput>(path: string, data: DataInput): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`, "utf8");
}
