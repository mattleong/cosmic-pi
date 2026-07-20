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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { JsonDocumentStore, type JsonDocumentStoreShape, type JsonObject } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import { setActivePlatformRunner } from "../boundary/platform";
import { makeCodePreviewRuntime } from "../boundary/runtime";
import { ShikiAdapter } from "../boundary/shiki";
import { codePreviewSettings, defaultCodePreviewSettings, setCodePreviewSettings } from "./index";
import { loadCodePreviewSettings } from "./bootstrap";
import { queueSettingsSave } from "./persistence";
import { cleanupTestTempDirectories, createTestTempDirectory } from "../testing/temp-directories";
import {
  extractCodePreviewSettings,
  getSettingsPath,
  getSettingsSaveContext,
  loadSettingsFromDisk,
  saveSettingsToDisk,
} from "./store";

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalCwd = process.cwd();

afterEach(async () => {
  setActivePlatformRunner(undefined);
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

test("extractCodePreviewSettings accepts nested, prefixed, and saved raw settings", () => {
  assert.deepEqual(extractCodePreviewSettings({ codePreview: { readCollapsedLines: 20 } }), {
    readCollapsedLines: 20,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewReadCollapsedLines: 30 }), {
    readCollapsedLines: 30,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewReadContentPreview: false }), {
    readContentPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewWriteContentPreview: false }), {
    writeContentPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewEditDiffPreview: false }), {
    editDiffPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewGrepResultPreview: false }), {
    grepResultPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewFindResultPreview: false }), {
    findResultPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewLsResultPreview: false }), {
    lsResultPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewBashResultPreview: false }), {
    bashResultPreview: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewToolCallBackground: false }), {
    toolCallBackground: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewToolCallTiming: false }), {
    toolCallTiming: false,
  });
  assert.deepEqual(extractCodePreviewSettings({ codePreviewTools: ["bash", "write"] }), {
    tools: ["bash", "write"],
  });
  assert.deepEqual(
    extractCodePreviewSettings({ ...defaultCodePreviewSettings, readCollapsedLines: 40 })
      .readCollapsedLines,
    40,
  );
  assert.deepEqual(extractCodePreviewSettings({ pathIcons: "off" }), { pathIcons: "off" });
  assert.deepEqual(extractCodePreviewSettings({ theme: "dark" }), {});
});

test("saving preserves unknown root and nested settings fields", async () => {
  const root = await createTestTempDirectory("pi-code-previews-unknown-");
  process.env.PI_CODING_AGENT_DIR = root;
  await writeJson(join(root, "code-previews.json"), {
    owner: "keep",
    codePreview: { readCollapsedLines: 12, futureSetting: { enabled: true } },
  });
  const loaded = await loadSettingsFromDisk();
  assert.ok(loaded);
  await saveSettingsToDisk({ ...loaded, readCollapsedLines: 20 }, getSettingsSaveContext());
  const saved = JSON.parse(await readFile(join(root, "code-previews.json"), "utf8"));
  assert.equal(saved.owner, "keep");
  assert.equal(saved.codePreview.readCollapsedLines, 20);
  assert.deepEqual(saved.codePreview.futureSetting, { enabled: true });
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

test("loadSettingsFromDisk merges settings in precedence order", async () => {
  const root = await createTestTempDirectory("pi-code-previews-precedence-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(project, ".pi"), { recursive: true });

  await writeJson(join(home, ".pi", "settings.json"), {
    codePreview: {
      readCollapsedLines: 11,
      writeCollapsedLines: 21,
      writeContentPreview: false,
    },
  });
  await writeJson(join(home, ".pi", "agent", "settings.json"), {
    codePreview: { readCollapsedLines: 12, editDiffPreview: false, grepCollapsedLines: 22 },
  });
  await writeJson(join(agentDir, "settings.json"), {
    codePreview: { readCollapsedLines: 13, findResultPreview: false },
  });
  await writeJson(join(project, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 14, lsResultPreview: false },
  });
  await writeJson(join(home, ".pi", "agent", "code-previews.json"), {
    readCollapsedLines: 15,
    bashResultPreview: false,
  });
  await writeJson(join(agentDir, "code-previews.json"), {
    readCollapsedLines: 16,
    pathListCollapsedLines: 44,
  });

  const loaded = await loadSettingsFromDisk({ projectCwd: project, projectTrusted: true });
  assert.equal(loaded?.readCollapsedLines, 16);
  assert.equal(loaded?.writeCollapsedLines, 21);
  assert.equal(loaded?.writeContentPreview, false);
  assert.equal(loaded?.editDiffPreview, false);
  assert.equal(loaded?.grepCollapsedLines, 22);
  assert.equal(loaded?.findResultPreview, false);
  assert.equal(loaded?.lsResultPreview, false);
  assert.equal(loaded?.bashResultPreview, false);
  assert.equal(loaded?.pathListCollapsedLines, 44);
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
  await queueSettingsSave({ ...first, shikiTheme: "github-dark" });

  const saved = JSON.parse(await readFile(join(agentDir, "code-previews.json"), "utf8"));
  assert.deepEqual(saved, { shikiTheme: "github-dark" });
  const second = await loadSettingsFromDisk({ projectCwd: secondProject, projectTrusted: true });
  assert.equal(second?.readCollapsedLines, 22);
  assert.equal(second?.shikiTheme, "github-dark");
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
  await queueSettingsSave({ ...first, shikiTheme: "github-dark" });

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

test("loadSettingsFromDisk warns on invalid JSON and continues", async () => {
  const root = await createTestTempDirectory("pi-code-previews-invalid-settings-");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeJson(join(home, ".pi", "settings.json"), {
    codePreview: { readCollapsedLines: 18 },
  });
  await writeFile(join(home, ".pi", "agent", "settings.json"), "{invalid", "utf8");
  await writeJson(join(agentDir, "code-previews.json"), { grepCollapsedLines: 31 });

  const originalWarn = console.warn;
  const warnings: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnings.push(args);
  try {
    const loaded = await loadSettingsFromDisk();
    assert.equal(loaded?.readCollapsedLines, 18);
    assert.equal(loaded?.grepCollapsedLines, 31);
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0]?.[0]), /Failed to load settings/);
  } finally {
    console.warn = originalWarn;
  }
});

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`, "utf8");
}

function installOwnedSettingsRuntime(service: JsonDocumentStoreShape) {
  const layer = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    Layer.succeed(JsonDocumentStore, JsonDocumentStore.of(service)),
    ShikiAdapter.layer,
  );
  const runtime = makeCodePreviewRuntime({} as ExtensionAPI, layer);
  setActivePlatformRunner({
    run: (effect, signal) => runtime.run(effect, signal),
    runShiki: (effect, signal) => runtime.run(effect, signal),
    forkShiki: (effect) => runtime.fork(effect),
  });
  return runtime;
}

test("active-session settings loads and saves are interrupted and finalized by runtime disposal", async () => {
  const configDir = await createTestTempDirectory("pi-code-previews-owned-settings-");
  process.env.PI_CODING_AGENT_DIR = configDir;
  let loadStarted: (() => void) | undefined;
  const loading = new Promise<void>((resolve) => {
    loadStarted = resolve;
  });
  let loadInterrupted = 0;
  const loadRuntime = installOwnedSettingsRuntime({
    exists: () => Effect.succeed(true),
    readObject: () =>
      Effect.sync(() => loadStarted?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => loadInterrupted++)),
      ),
    writeObject: () => Effect.sync(() => void 0),
    updateObject: (_path, update) => Effect.sync(() => update({})),
  });
  const load = loadSettingsFromDisk();
  await loading;
  await loadRuntime.dispose();
  await assert.rejects(load);
  assert.equal(loadInterrupted, 1);

  let saveStarted: (() => void) | undefined;
  const saving = new Promise<void>((resolve) => {
    saveStarted = resolve;
  });
  let saveInterrupted = 0;
  const saveRuntime = installOwnedSettingsRuntime({
    exists: () => Effect.succeed(false),
    readObject: () => Effect.sync(() => undefined),
    writeObject: () => Effect.sync(() => void 0),
    updateObject: (_path, _update) =>
      Effect.sync(() => saveStarted?.()).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => saveInterrupted++)),
      ),
  });
  const save = saveSettingsToDisk({
    ...defaultCodePreviewSettings,
    readCollapsedLines: 37,
  });
  await saving;
  await saveRuntime.dispose();
  await assert.rejects(save);
  assert.equal(saveInterrupted, 1);
  setActivePlatformRunner(undefined);
});

test("concurrent load and save share one settings coordination domain", async () => {
  const configDir = await createTestTempDirectory("pi-code-previews-settings-order-");
  process.env.PI_CODING_AGENT_DIR = configDir;
  const documents = new Map<string, JsonObject>();
  let active = 0;
  let maximum = 0;
  const service: JsonDocumentStoreShape = {
    exists: (path) => Effect.succeed(documents.has(path)),
    readObject: (path) =>
      Effect.sync(() => {
        active++;
        maximum = Math.max(maximum, active);
        active--;
        return documents.get(path);
      }),
    writeObject: (path, document) =>
      Effect.sync(() => {
        documents.set(path, document);
      }),
    updateObject: (path, update) =>
      Effect.gen(function* () {
        active++;
        maximum = Math.max(maximum, active);
        yield* Effect.yieldNow;
        const next = update(documents.get(path) ?? {});
        documents.set(path, next);
        active--;
        return next;
      }),
  };
  const runtime = installOwnedSettingsRuntime(service);
  await Promise.all([
    loadSettingsFromDisk(),
    saveSettingsToDisk({ ...defaultCodePreviewSettings, readCollapsedLines: 44 }),
    loadSettingsFromDisk(),
  ]);
  assert.equal(maximum, 1);
  await runtime.dispose();
  setActivePlatformRunner(undefined);
});
