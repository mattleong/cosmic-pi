import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
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
import { SearchableSelectPage } from "../../src/manager/searchable-select.ts";
import { ModelPickerPage, type ModelPickerModel } from "../../src/manager/model-picker.ts";
import {
  fullScreenKeybindingOptions,
  keyHintBar,
  keyHintRows,
  moveKeyHint,
  keyHint,
} from "../../src/manager/key-labels.ts";
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

// Pi hands pickers its configured select keys, such as `escape`/`ctrl+c` for cancel.
const piKeybindings = () => fullScreenKeybindingOptions(getKeybindings());

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

// As /subagents settings shows them: inherited rows read `inherit (value)`, choice lists offer
// that same label, and a group's summary names the values in effect, inherited or not.
const scopeGroup = (name: string, own: boolean): SettingsSurfaceItem => {
  const field = (id: string, label: string, values: readonly [string, string, ...string[]]) => {
    const [ownValue, inheritedValue, ...presets] = values;
    const inherited = `inherit (${inheritedValue})`;
    return {
      id: `${name}:${id}`,
      label,
      currentValue: own ? ownValue : inherited,
      values: [inherited, ...presets],
    };
  };
  return {
    kind: "group",
    id: `group:${name}`,
    label: name,
    description: `Delegation and nesting limits for the ${Str.toLowerCase(name)} scope.`,
    // Like the real summary, limits at their defaults are left to the rows.
    currentValue: own ? "encouraged · 16 children" : "normal",
    children: [
      field("delegation", "Delegation", [
        "encouraged",
        "normal",
        "normal",
        "encouraged",
        "orchestration",
      ]),
      field("maxDirectChildren", "Max children", ["16", "8", "4", "8", "16"]),
      field("maxDepth", "Max depth", ["2", "2", "1", "2", "3"]),
      field("maxActiveRuns", "Max active", ["16", "8", "4", "8", "16"]),
    ],
  };
};

const scopedSettingsFrames = (): string[] => {
  const surface = settingsSurface(
    withSettingsGroupChildren(
      [
        {
          id: "workspace",
          label: "Writer workspace",
          description: "Default for writers that don't set isolation.",
          currentValue: "Shared checkout",
          values: ["Shared checkout", "Worktree"],
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
  surface.handleInput?.(DOWN);
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · inside an inheriting scope group", render, 57));
  lines.push(...frame("Settings · inside an inheriting scope group", render, 100));
  surface.handleInput?.("\r");
  lines.push(...frame("Settings · inherited choice reads inherit (value)", render, 57));
  lines.push(...frame("Settings · inherited choice reads inherit (value)", render, 100));
  return lines;
};

/** A value listing facts clips at a fact boundary, never after a dangling separator. */
const factSummarySettingsFrames = (): string[] => {
  const surface = settingsSurface(
    withSettingsGroupChildren(
      [
        {
          kind: "group",
          id: "group:output",
          label: "Output previews",
          description: "Which tool outputs show a preview.",
          currentValue: "read off · write off · edit off · bash off",
          children: [
            {
              id: "read",
              label: "read",
              description: "Preview read output.",
              currentValue: "off",
              values: ["on", "off"],
            },
          ],
        },
      ],
      listTheme,
      () => undefined,
    ),
    "Code Previews settings",
  );
  const render = (width: number) => surface.render(width);
  return [
    ...frame("Settings · summary of facts", render, 100),
    ...frame("Settings · summary of facts clipped at a fact", render, 57),
  ];
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
    ...frame("Panel · scrolled, expanded help", (width) => scrolling.render(width), 57),
    ...frame("Panel · scrolled, expanded help", (width) => scrolling.render(width), 120),
    ...frame("Panel · nested (Esc Back)", (width) => nested.render(width), 48),
  );
  return lines;
};

/** Footer, shared settings surface, and text panel states for the presentation gallery. */
/**
 * The framed searchable picker: its whole bar fits the border when wide; at 57 columns the
 * border keeps the exit and `? More`, and the other pairs wrap above it, as in search mode.
 * Value pickers mark the current value `(•)`; the focused row carries `›`.
 */
const searchableSelectFrames = (): string[] => {
  const choices = Arr.map(["gpt-6-luna", "gpt-6-sol", "claude-opus-5-5"], (name) => {
    const value = `provider/${name}`;
    return {
      value,
      item: { value, label: value, description: name },
      searchText: value,
      payload: value,
    };
  });
  const picker = new SearchableSelectPage<string>({
    ...piKeybindings(),
    theme: plainTheme,
    breadcrumb: "Current session › reviewer › Primary › Model",
    title: "Choose model",
    subtitle: "Models available to this session",
    choices,
    current: "provider/gpt-6-luna",
    markedValue: "provider/gpt-6-luna",
    getHeight: () => 16,
    requestRender: () => undefined,
    select: () => undefined,
    cancel: () => undefined,
  });
  const lines = [
    ...frame("searchable picker", (width) => picker.render(width), 180),
    ...frame("searchable picker", (width) => picker.render(width), 100),
    ...frame("searchable picker · narrow", (width) => picker.render(width), 57),
  ];
  picker.handleInput("?");
  lines.push(...frame("searchable picker · expanded help · narrow", (w) => picker.render(w), 57));
  picker.handleInput("?");
  picker.handleInput("/");
  lines.push(...frame("searchable picker · filtering · narrow", (w) => picker.render(w), 57));
  return [...lines, ...fieldPickerFrames(), ...modelPickerFrames()];
};

const model = (provider: string, id: string): ModelPickerModel => ({
  provider,
  id,
  reasoning: true,
  supportedEfforts: ["low", "medium", "high"],
});

/** The model picker names its scope in the subtitle and the scope Tab switches to in its bar. */
const modelPickerFrames = (): string[] => {
  const scoped = [model("openai-codex", "gpt-6-luna"), model("claude-bridge", "claude-opus-5-5")];
  const picker = new ModelPickerPage({
    ...piKeybindings(),
    theme: plainTheme,
    breadcrumb: "Current session › reviewer › Primary › Model",
    scopedModels: scoped,
    allModels: [...scoped, model("opencode", "gpt-6.1-sol")],
    current: "openai-codex/gpt-6-luna",
    getHeight: () => 14,
    requestRender: () => undefined,
    select: () => undefined,
    cancel: () => undefined,
  });
  const lines = [
    ...frame("model picker · scoped models", (w) => picker.render(w), 180),
    ...frame("model picker · scoped models · narrow", (w) => picker.render(w), 57),
  ];
  picker.handleInput("\t");
  lines.push(
    ...frame("model picker · all models", (w) => picker.render(w), 180),
    ...frame("model picker · all models · narrow", (w) => picker.render(w), 57),
  );
  picker.handleInput("?");
  lines.push(
    ...frame("model picker · expanded help", (w) => picker.render(w), 180),
    ...frame("model picker · expanded help · narrow", (w) => picker.render(w), 57),
  );
  picker.handleInput("?");
  picker.handleInput("/");
  lines.push(
    ...frame("model picker · filtering", (w) => picker.render(w), 180),
    ...frame("model picker · filtering · narrow", (w) => picker.render(w), 57),
  );
  return lines;
};

/** A profile field picker: the current value reads `(•)` while the cursor moves. */
const fieldPickerFrames = (): string[] => {
  const efforts = [
    ["inherit (high)", "Use the parent session's level"],
    ["off", "No extended reasoning"],
    ["minimal", "Fastest; least reasoning"],
    ["low", "Light reasoning"],
    ["medium", "Balanced"],
    ["high", "Thorough reasoning"],
    ["xhigh", "Most thorough; slowest"],
  ] as const;
  const choices = Arr.map(efforts, ([value, description]) => ({
    value,
    item: { value, label: value, description },
    searchText: `${value} ${description}`,
    payload: value,
  }));
  const fieldPicker = (height: number) =>
    new SearchableSelectPage<string>({
      ...piKeybindings(),
      theme: plainTheme,
      breadcrumb: "Current session › reviewer › Primary › Reasoning",
      title: "Choose reasoning",
      subtitle: "Editing current session",
      choices,
      current: "high",
      markedValue: "high",
      getHeight: () => height,
      requestRender: () => undefined,
      select: () => undefined,
      cancel: () => undefined,
    });
  const picker = fieldPicker(16);
  const lines = [
    ...frame("field picker · Choose reasoning", (width) => picker.render(width), 180),
    ...frame("field picker · Choose reasoning · narrow", (width) => picker.render(width), 57),
  ];
  picker.handleInput(DOWN);
  lines.push(
    ...frame(
      "field picker · cursor moved off the current value · narrow",
      (w) => picker.render(w),
      57,
    ),
  );
  picker.handleInput("?");
  lines.push(...frame("field picker · expanded help", (w) => picker.render(w), 180));
  const short = fieldPicker(9);
  lines.push(...frame("field picker · short pane scrolls · narrow", (w) => short.render(w), 57));
  return lines;
};

export const sharedSurfaceGalleryLines = (): string[] => {
  setKeybindings(new TuiKeybindingsManager(TUI_KEYBINDINGS));
  return [
    ...footerFrames("comfortable"),
    ...footerFrames("compact"),
    ...footerFrames("auto"),
    ...cosmicUiSettingsFrames(),
    ...groupedSettingsFrames(),
    ...scopedSettingsFrames(),
    ...factSummarySettingsFrames(),
    ...panelFrames(),
    ...tableFrames(),
    ...hintFrames(),
    ...affordanceFrames(),
    ...searchableSelectFrames(),
  ];
};
