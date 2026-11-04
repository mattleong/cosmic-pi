import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager as TuiKeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  type SettingItem,
} from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  extensionApiFixture,
  extensionContextFixture,
  footerDataFixture,
  modelFixture,
  plainTheme,
} from "pi-cosmic-core/testing";
import {
  defaultResolvedCosmicUiConfig,
  type FooterDensity,
  type ResolvedCosmicUiConfig,
} from "../../src/config/schema.ts";
import { createFooterComponent } from "../../src/footer/component.ts";
import type { FooterGitStatus } from "../../src/footer/git.ts";
import { TextPanelComponent } from "../../src/manager/panel.ts";
import {
  createSettingsGroupSubmenu,
  createSettingsListSurface,
  managerSettingsTheme,
  settingsSurfaceHeader,
  type SettingsSurfaceItem,
  withSettingsGroupChildren,
} from "../../src/manager/settings-surface.ts";
import { managerTable } from "../../src/manager/table.ts";
import { keyHintBar, keyHintRows, moveKeyHint, keyHint } from "../../src/manager/key-labels.ts";
import { renderExpansionAffordance } from "../../src/tool/presentation.ts";
import type { CosmicFooterContribution } from "../../src/protocol/protocol.ts";
import { cosmicUiSettingsItems } from "../../src/settings/controller.ts";

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const ESC = "\u001b";

const gitStatus: FooterGitStatus = {
  staged: 0,
  modified: 1,
  untracked: 1,
  conflicts: 0,
  ahead: 1,
  behind: 0,
  linesAdded: 4,
  linesRemoved: 2,
  linesChanged: 0,
};

const usage: CosmicFooterContribution = {
  kind: "text",
  id: "openai.usage",
  region: "details",
  label: "OpenAI",
  text: "Usage: 5h: 50% | 7d: 90% | 5h ↺ 2h 3m - 10:59 PM | 7d ↺ 6d 1h - Nov 9, 10:59 PM",
  compactText: "Usage: 7d: 90% | 7d ↺ 6d 1h - Nov 9, 10:59 PM",
};

const footerContext = (): ExtensionContext =>
  extensionContextFixture({
    model: modelFixture({
      id: "gpt-6.1-sol",
      provider: "openai-codex",
      reasoning: true,
      contextWindow: 400_000,
    }),
    modelRegistry: { isUsingOAuth: () => true },
    sessionManager: {
      getCwd: () => "/Users/dev/projects/cosmic-pi",
      getLeafId: () => null,
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ tokens: 84_000, contextWindow: 400_000, percent: 21 }),
  });

const footerFrames = (density: FooterDensity): string[] => {
  const ctx = footerContext();
  const defaults = defaultResolvedCosmicUiConfig();
  const config: ResolvedCosmicUiConfig = { ...defaults, footer: { ...defaults.footer, density } };
  const component = createFooterComponent({
    pi: extensionApiFixture({ getThinkingLevel: () => "high" }),
    ctx: () => ctx,
    footerData: footerDataFixture({
      getGitBranch: () => "main",
      getAvailableProviderCount: () => 1,
      getExtensionStatuses: () => new Map([["probe", "Docs index ready"]]),
    }),
    theme: plainTheme,
    registry: { snapshot: () => ({ contributions: [usage] }) },
    config: () => config,
    projection: () => ({
      totals: {
        input: 1_240_000,
        output: 45_200,
        cacheRead: 163_000,
        cacheWrite: 12_400,
        cost: 0.08,
      },
      gitStatus,
      pullRequestNumber: 1742,
      pullRequestUrl: undefined,
      homeDirectory: "/Users/dev",
    }),
  });
  return Arr.flatMap([140, 100, 72, 57, 40], (width) => [
    `── Footer · ${density} density · ${width} cols`,
    ...component.render(width),
    "",
  ]);
};

const listTheme = managerSettingsTheme(plainTheme);

const settingsSurface = (items: SettingsSurfaceItem[], title: string) => {
  const created = createSettingsListSurface({
    header: settingsSurfaceHeader(plainTheme, title),
    items,
    height: items.length,
    listTheme,
    onChange: () => undefined,
    onCancel: () => undefined,
    matchesKeybinding: undefined,
    requestRender: () => undefined,
    dim: (text) => text,
    bridge: {},
  });
  return created.surface;
};

const frame = (label: string, render: (width: number) => string[], width: number): string[] => [
  `── ${label} · ${width} cols`,
  ...render(width),
  "",
];

const cosmicUiSettingsFrames = (): string[] => {
  const surface = settingsSurface(
    cosmicUiSettingsItems(defaultResolvedCosmicUiConfig()),
    "Cosmic UI settings",
  );
  const render = (width: number) => surface.render(width);
  const lines = [...frame("Settings · boolean row (Enter Toggle)", render, 100)];
  surface.handleInput?.(DOWN);
  lines.push(...frame("Settings · enum row (Enter Change)", render, 100));
  surface.handleInput?.("\r");
  surface.handleInput?.(DOWN);
  lines.push(...frame("Settings · choice list, browsing without saving", render, 100));
  surface.handleInput?.(ESC);
  surface.handleInput?.("?");
  lines.push(...frame("Settings · expanded help", render, 100));
  surface.handleInput?.("?");
  lines.push(...frame("Settings · narrow", render, 57));
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · choice list", render, 57));
  surface.handleInput?.(ESC);
  surface.handleInput?.("?");
  lines.push(...frame("Settings · expanded help, wrapped between pairs", render, 57));
  surface.handleInput?.("?");
  surface.handleInput?.("/");
  surface.handleInput?.("g");
  surface.handleInput?.("i");
  lines.push(...frame("Settings · filtering", render, 100));
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · filter kept after Enter (Esc Clear)", render, 57));
  surface.handleInput?.(ESC);
  surface.handleInput?.("/");
  for (const key of "zzz") surface.handleInput?.(key);
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · filter applied, nothing matches", render, 57));
  return lines;
};

const scopeGroup = (name: string, own: boolean): SettingsSurfaceItem => ({
  kind: "group",
  id: `group:${name}`,
  label: name,
  description: `Delegation and nesting limits for the ${Str.toLowerCase(name)} scope.`,
  currentValue: own ? "normal · 32 children · depth 3 · 16 active" : "inherit all",
  children: [
    {
      id: `${name}:delegation`,
      label: "Delegation",
      currentValue: own ? "normal" : "inherit (normal)",
      values: ["inherit", "normal", "eager", "off"],
    },
    {
      id: `${name}:maxChildren`,
      label: "Max children",
      currentValue: own ? "32" : "inherit (32)",
      values: ["inherit", "8", "16", "32"],
    },
    {
      id: `${name}:maxDepth`,
      label: "Max depth",
      currentValue: own ? "3" : "inherit (3)",
      values: ["inherit", "1", "2", "3"],
    },
    {
      id: `${name}:maxActive`,
      label: "Max active",
      currentValue: own ? "16" : "inherit (16)",
      values: ["inherit", "4", "8", "16"],
    },
  ],
});

const scopedSettingsFrames = (): string[] => {
  const surface = settingsSurface(
    withSettingsGroupChildren(
      [
        {
          id: "workspace",
          label: "Writer workspace",
          description: "Default for writers that don't set isolation.",
          currentValue: "shared-checkout",
          values: ["shared-checkout", "worktree"],
        },
        scopeGroup("Session", false),
        scopeGroup("Global", true),
        scopeGroup("Project", false),
      ],
      listTheme,
      () => undefined,
    ),
    "Subagents settings",
  );
  const render = (width: number) => surface.render(width);
  const lines = [...frame("Settings · rows grouped by scope", render, 100)];
  lines.push(...frame("Settings · rows grouped by scope", render, 57));
  surface.handleInput?.(DOWN);
  surface.handleInput?.(DOWN);
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · inside a scope group", render, 57));
  return lines;
};

const tableFrames = (): string[] => {
  const rows = [
    ["scout", "openai-codex/gpt-6-luna", "low", ""],
    ["planner", "claude-bridge/claude-opus-5-5", "high", ""],
    ["oracle", "openai-codex/gpt-6-astra", "xhigh", ""],
  ];
  const columns = [
    { minWidth: 8, priority: 5 },
    { minWidth: 8, priority: 4 },
    { minWidth: 5, priority: 3 },
    { minWidth: 11, priority: 1 },
  ];
  const render = (width: number) => {
    const table = managerTable(rows, columns, width - 2);
    return Arr.map(rows, (row) => `  ${table.row(row)}`);
  };
  return [
    ...frame("Table · an all-empty column takes no space", render, 100),
    ...frame("Table · an all-empty column takes no space", render, 57),
  ];
};

const hintFrames = (): string[] => {
  const hint = keyHintBar(
    {
      hints: [
        moveKeyHint("↑↓"),
        keyHint("Enter", "Inspect"),
        keyHint("x", "Stop"),
        keyHint("c", "Clear finished"),
      ],
      more: [keyHint("j/k", "Move"), keyHint("PgUp/PgDn", "Page"), keyHint("gg/G", "Ends")],
      exit: "top",
      exitAliases: ["C-c", "q"],
    },
    true,
  );
  const render = (width: number) => keyHintRows(hint, width);
  return [
    ...frame("Hint bar · wraps between pairs", render, 57),
    ...frame("Hint bar · wraps between pairs", render, 40),
  ];
};

const affordanceFrames = (): string[] =>
  frame(
    "Expansion affordance · collapsed and expanded",
    () => [
      renderExpansionAffordance("output", false, plainTheme),
      renderExpansionAffordance("output", true, plainTheme),
    ],
    57,
  );

const panelLines = [
  "Status: ready",
  "Configured tools: read, write, edit, bash, grep, find, ls, codemode, mcp, tool_search, ask_user, background_task, agent_start, agent_report",
  "Theme: github-dark-default",
  "  Loaded languages: typescript, javascript, json, markdown, shell, python, rust, go, yaml, toml",
  ...Array.from({ length: 14 }, (_, index) => `Diagnostic ${index + 1}: ok`),
  "Settings file: /Users/dev/.pi/agent/extensions/code-previews/settings.json",
];

const groupedSettingsFrames = (): string[] => {
  const values = new Map<string, string>([
    ["timing", "on"],
    ["style", "preview"],
  ]);
  const items = (): SettingItem[] => [
    {
      id: "timing",
      label: "Tool timing",
      description: "Show how long each tool call took.",
      currentValue: values.get("timing") ?? "on",
      values: ["on", "off"],
    },
    {
      id: "style",
      label: "Collapsed style",
      description: "How collapsed tool rows look.",
      currentValue: values.get("style") ?? "preview",
      values: ["preview", "compact"],
    },
  ];
  const surface = settingsSurface(
    [
      {
        kind: "group",
        id: "group:appearance",
        label: "Appearance",
        description: "Tool frames, timing, and collapsed style.",
        currentValue: "preview · timing on",
        submenu: (_value, done) =>
          createSettingsGroupSubmenu({
            title: "Appearance",
            description: "Tool frames, timing, and collapsed style.",
            items,
            onChange: (id, value) => {
              values.set(id, value);
            },
            done,
            listTheme,
          }),
      },
      {
        id: "debug",
        label: "Debug info",
        description: "Show diagnostics.",
        currentValue: "open",
        submenu: (_value, done) =>
          new TextPanelComponent({
            title: "Debug info",
            theme: plainTheme,
            lines: panelLines,
            done: () => done(),
            exit: "nested",
            maxHeight: () => 8,
          }),
      },
      {
        id: "file",
        label: "Settings file",
        description: "Where these settings are saved.",
        currentValue: "~/.pi/agent/code-previews.json",
      },
    ],
    "Grouped settings",
  );
  const render = (width: number) => surface.render(width);
  const lines = [...frame("Settings · group row (Enter Open)", render, 100)];
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · inside a group (single hint, Esc Back)", render, 100));
  surface.handleInput?.(DOWN);
  surface.handleInput?.("?");
  lines.push(...frame("Settings · inside a group, expanded help", render, 100));
  surface.handleInput?.("?");
  surface.handleInput?.(UP);
  surface.handleInput?.(ESC);
  surface.handleInput?.(DOWN);
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · panel opened from a row (its own hint only)", render, 72));
  surface.handleInput?.(ESC);
  surface.handleInput?.(DOWN);
  lines.push(...frame("Settings · plain value row (no Enter action)", render, 100));
  return lines;
};

const panelFrames = (): string[] => {
  const fits = new TextPanelComponent({
    title: "Code preview health",
    theme: plainTheme,
    lines: Arr.take(panelLines, 4),
    done: () => undefined,
  });
  const scrolling = new TextPanelComponent({
    title: "Code preview health",
    theme: plainTheme,
    lines: panelLines,
    done: () => undefined,
    maxHeight: () => 12,
  });
  const nested = new TextPanelComponent({
    title: "Config paths",
    theme: plainTheme,
    lines: ["Selected: /Users/dev/projects/cosmic-pi/.pi/better-openai.json"],
    done: () => undefined,
    exit: "nested",
  });
  const lines = [
    ...frame("Panel · fits, wraps long lines", (width) => fits.render(width), 60),
    ...frame("Panel · scrollable", (width) => scrolling.render(width), 60),
  ];
  scrolling.handleInput("j");
  scrolling.handleInput("j");
  scrolling.handleInput("?");
  lines.push(
    ...frame("Panel · scrolled, expanded help", (width) => scrolling.render(width), 60),
    ...frame("Panel · nested (Esc Back)", (width) => nested.render(width), 48),
  );
  return lines;
};

/** Footer, shared settings surface, and text panel states for the presentation gallery. */
export const sharedSurfaceGalleryLines = (): string[] => {
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  return [
    ...footerFrames("comfortable"),
    ...footerFrames("compact"),
    ...footerFrames("auto"),
    ...cosmicUiSettingsFrames(),
    ...groupedSettingsFrames(),
    ...scopedSettingsFrames(),
    ...panelFrames(),
    ...tableFrames(),
    ...hintFrames(),
    ...affordanceFrames(),
  ];
};
