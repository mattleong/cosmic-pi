// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/globalConsole:off
// @effect-diagnostics effect/globalDate:off
import { runtimeTypeName } from "pi-cosmic-core";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionHandler,
  KeybindingsManager,
  RegisteredCommand,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import codePreviews, {
  getCodePreviewToolIcon,
  loadCodePreviewSettings,
  withCodePreviewShell,
} from "../index";
import type { CodePreviewSettings, ToolCallBackgroundMode } from "../index";
import { defaultCodePreviewSettings } from "../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { renderComponent, stripAnsi, testTheme } from "../src/testing/render";
import {
  cleanupTestTempDirectories,
  createTestTempDirectory,
} from "../src/testing/temp-directories";

const extensionContextFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & ExtensionContext => {
  // SAFETY: Each test invokes only the context members implemented by its fixture.
  return fixture as Fixture & ExtensionContext;
};

const tuiFixture = <Fixture extends object>(fixture: Fixture): Fixture & TUI => {
  // SAFETY: These custom-surface tests do not invoke TUI members.
  return fixture as Fixture & TUI;
};

const keybindingsFixture = <Fixture extends object>(
  fixture: Fixture,
): Fixture & KeybindingsManager => {
  // SAFETY: These custom-surface tests do not invoke keybinding-manager members.
  return fixture as Fixture & KeybindingsManager;
};

const testTui = tuiFixture({});
const testKeybindings = keybindingsFixture({});

const originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalHome = process.env.HOME;
const originalSettings = { ...codePreviewSettings, tools: [...codePreviewSettings.tools] };

test("root public API exposes stable package-author helpers", () => {
  const mode: ToolCallBackgroundMode = "border";
  const settings: CodePreviewSettings = { ...defaultCodePreviewSettings, toolCallBackground: mode };
  assert.equal(settings.toolCallBackground, "border");
  assert.equal(runtimeTypeName(codePreviews), "function");
  assert.equal(runtimeTypeName(loadCodePreviewSettings), "function");
  assert.equal(runtimeTypeName(withCodePreviewShell), "function");
  assert.equal(getCodePreviewToolIcon("read"), "📖");
});

test("cooperative shell captures mode when the tool is wrapped", () => {
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  const tool = { name: "example", label: "Example" } as Parameters<typeof withCodePreviewShell>[0];
  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallBackground: "on" });
  const wrappedBeforeReload = withCodePreviewShell(tool);

  setCodePreviewSettings({ ...defaultCodePreviewSettings, toolCallBackground: "border" });
  const wrappedAfterReload = withCodePreviewShell(tool);

  assert.equal(wrappedBeforeReload.renderShell, "default");
  assert.equal(wrappedAfterReload.renderShell, "self");
});

afterEach(async () => {
  restoreEnv("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
  restoreEnv("HOME", originalHome);
  setCodePreviewSettings(originalSettings);
  await cleanupTestTempDirectories();
});

test("extension entrypoint registers commands and session renderer wiring", async () => {
  const root = await createTestTempDirectory("pi-code-previews-index-");
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = join(root, "home");
  await writeFile(
    join(root, "code-previews.json"),
    JSON.stringify({ ...defaultCodePreviewSettings, syntaxHighlighting: false, tools: ["grep"] }),
    "utf8",
  );

  const commands = new Map<string, { handler: RegisteredCommand["handler"] }>();
  const handlers = new Map<string, ExtensionHandler<any, any>>();
  const registeredTools: string[] = [];
  let activeTools = ["read", "bash"];
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  await codePreviews({
    registerCommand: (name: string, command: { handler: RegisteredCommand["handler"] }) => {
      commands.set(name, command);
    },
    on: (event: string, handler: ExtensionHandler<any, any>) => {
      handlers.set(event, handler);
    },
    registerTool: (tool: { name: string }) => {
      registeredTools.push(tool.name);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => {
      activeTools = tools;
    },
  } as never);

  assert.ok(commands.has("code-preview-health"));
  assert.ok(commands.has("code-preview-settings"));
  await handlers.get("session_start")?.(
    { type: "session_start", reason: "startup" },
    extensionContextFixture({ cwd: root }),
  );
  assert.deepEqual(registeredTools, ["grep"]);
  assert.deepEqual(activeTools, ["read", "bash", "grep"]);
  await handlers.get("session_shutdown")?.({}, extensionContextFixture({ cwd: root }));
});

test("session replacement, abort, and shutdown are idempotent", async () => {
  const root = await createTestTempDirectory("pi-code-previews-lifecycle-");
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = join(root, "home");
  await writeFile(
    join(root, "code-previews.json"),
    JSON.stringify({ syntaxHighlighting: false, tools: [] }),
    "utf8",
  );
  const handlers = new Map<string, ExtensionHandler<any, any>>();
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  await codePreviews({
    registerCommand: () => undefined,
    registerTool: () => undefined,
    on: (name: string, handler: ExtensionHandler<any, any>) => handlers.set(name, handler),
  } as never);
  assert.ok(handlers.has("session_start"));
  assert.ok(handlers.has("session_shutdown"));
  const firstAbort = new AbortController();
  const context = {
    cwd: root,
    signal: firstAbort.signal,
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  };
  await handlers.get("session_start")?.({}, extensionContextFixture(context));
  firstAbort.abort();
  await Promise.resolve();
  await handlers.get("session_start")?.(
    {},
    extensionContextFixture({ ...context, signal: undefined }),
  );
  await handlers.get("session_shutdown")?.({}, extensionContextFixture(context));
  await handlers.get("session_shutdown")?.({}, extensionContextFixture(context));
  assert.equal(codePreviewSettings.syntaxHighlighting, false);
});

test("health command renders current settings", async () => {
  const root = await createTestTempDirectory("pi-code-previews-health-");
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = join(root, "home");
  const commands = await loadCommandsOnly();
  setCodePreviewSettings({ ...defaultCodePreviewSettings, syntaxHighlighting: false });
  let rendered = "";
  await commands.get("code-preview-health")?.handler("", {
    mode: "tui",
    ui: {
      custom: async (factory: CustomFactory) => {
        const component = factory(testTui, testTheme(), testKeybindings, () => undefined);
        rendered = stripAnsi(renderComponent(component));
      },
    },
  });

  assert.match(rendered, /Code preview health/);
  assert.match(rendered, /Syntax highlighting: off/);
  assert.match(rendered, /Settings file:/);
});

test("health command falls back to notify outside interactive TUI mode", async () => {
  const root = await createTestTempDirectory("pi-code-previews-health-rpc-");
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = join(root, "home");
  const commands = await loadCommandsOnly();
  setCodePreviewSettings({ ...defaultCodePreviewSettings, syntaxHighlighting: false });
  const notifications: string[] = [];
  await commands.get("code-preview-health")?.handler("", {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async () => assert.fail("custom UI must not open outside TUI mode"),
    },
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0] ?? "", /Syntax highlighting: off/);
});

test("settings command updates, saves, and notifies", async () => {
  const root = await createTestTempDirectory("pi-code-previews-settings-command-");
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = join(root, "home");
  await mkdir(root, { recursive: true });
  initTheme();

  const commands = await loadCommandsOnly();
  setCodePreviewSettings({ ...defaultCodePreviewSettings, syntaxHighlighting: false });
  const notifications: string[] = [];
  await commands.get("code-preview-settings")?.handler("", {
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async (factory: CustomFactory) =>
        new Promise<void>((resolve) => {
          const component = factory(testTui, testTheme(), testKeybindings, () => resolve());
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          const list = (component as typeof component & VimSettingsAdapterInternals).child;
          list.onChange("readCollapsedLines", "20");
          list.onCancel();
        }),
    },
  });

  const saved = JSON.parse(await readFile(join(root, "code-previews.json"), "utf8"));
  assert.equal(saved.readCollapsedLines, 20);
  assert.equal(notifications.length, 0);

  await commands.get("code-preview-settings")?.handler("", {
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async (factory: CustomFactory) =>
        new Promise<void>((resolve) => {
          const component = factory(testTui, testTheme(), testKeybindings, () => resolve());
          // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
          const list = (component as typeof component & VimSettingsAdapterInternals).child;
          list.onChange("resetToDefaults", "reset now");
          list.onCancel();
        }),
    },
  });
  assert.ok(notifications.some((message) => message.includes("reset to defaults")));

  await commands.get("code-preview-settings")?.handler("", {
    mode: "rpc",
    hasUI: true,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async () => assert.fail("custom UI must not open outside TUI mode"),
    },
  });
  assert.ok(notifications.some((message) => message.includes("interactive TUI mode")));
});

type CustomFactory = (
  tui: TUI,
  theme: ReturnType<typeof testTheme>,
  keybindings: KeybindingsManager,
  done: (value?: undefined) => void,
) => Component;

interface SettingsListInternals {
  onChange(id: string, value: string): void;
  onCancel(): void;
}

interface VimSettingsAdapterInternals {
  child: SettingsListInternals;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

type CommandContext = { mode?: string; hasUI?: boolean; ui: unknown };

async function loadCommandsOnly(): Promise<
  Map<string, { handler: (args: string, ctx: CommandContext) => Promise<void> }>
> {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: CommandContext) => Promise<void> }
  >();
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  await codePreviews({
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: CommandContext) => Promise<void> },
    ) => {
      commands.set(name, command);
    },
    on: () => undefined,
  } as never);
  return commands;
}
