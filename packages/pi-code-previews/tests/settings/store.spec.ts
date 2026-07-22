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
import { codePreviewSettings, defaultCodePreviewSettings, setCodePreviewSettings } from "../../src/settings/index";
import { loadCodePreviewSettings } from "../../src/settings/bootstrap";
import { queueSettingsSave } from "../../src/settings/persistence";
import { cleanupTestTempDirectories, createTestTempDirectory } from "../../src/testing/temp-directories";
import {
  extractCodePreviewSettings,
  getSettingsPath,
  getSettingsSaveContext,
  loadSettingsFromDisk,
  saveSettingsToDisk,
} from "../../src/settings/store";

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

test("loadSettingsFromDisk skips invalid JSON and continues", async () => {
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

  const loaded = await loadSettingsFromDisk();
  assert.equal(loaded?.readCollapsedLines, 18);
  assert.equal(loaded?.grepCollapsedLines, 31);
});

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data)}\n`, "utf8");
}
