import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  captureHostSignal,
  formatDisplayPath,
  isProjectTrusted,
  notifyAtHostBoundary,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import { settingsSubcommand } from "pi-cosmic-ui/boundary/host-settings-command";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import {
  managerSettingsTheme,
  createSettingsListSurface,
} from "pi-cosmic-ui/manager/settings-surface";
import type { LoadSettingsOptions } from "../config/document-store";
import { defaultCodePreviewStartupSettings } from "../config/defaults";
import type {
  CodePreviewEditableSettingId,
  CodePreviewSettings,
  CodePreviewStartupSettings,
} from "../config/schema";
import { codePreviewSettings } from "../config/state";
import {
  formatSettingsSaveError,
  getSettingsPath,
  loadCodePreviewStartupSettings,
  queueStartupSettingsSave,
  queueSettingsSave as persistOrdinarySettings,
} from "../config/store";
import { formatOnOff, formatSettingValue, updateSetting } from "../config/values";
import { getNativeMcpStatus } from "../tools/native-mcp-registration";
import { initializeShiki as initializePanelSyntax } from "../syntax/shiki";
import { createCodePreviewSettingsModel, persistSettingsChange } from "./panel";
import {
  NATIVE_MCP_SETTING,
  SETTING_ITEM_DEFINITIONS,
  type SettingItemDefinition,
} from "./ui/registry";

/** Settings a command can change directly; groups, tools, and the reset row are list-only. */
const SCRIPTED_SETTINGS = [
  ...Object.entries(SETTING_ITEM_DEFINITIONS).flatMap(
    ([id, definition]: [string, SettingItemDefinition]) =>
      id === "settingsFile" || id === "tools" || id === "resetToDefaults"
        ? []
        : [
            {
              // SAFETY: Every remaining ordinary registry key is an editable settings field.
              id: id as CodePreviewEditableSettingId,
              description: definition.description,
              ...(definition.values && { values: [...definition.values] }),
            },
          ],
  ),
  {
    id: NATIVE_MCP_SETTING.id,
    description: NATIVE_MCP_SETTING.description,
    values: [...NATIVE_MCP_SETTING.values],
  },
];

type CommandSettings = CodePreviewSettings & CodePreviewStartupSettings;
type CommandSettingId = CodePreviewEditableSettingId | typeof NATIVE_MCP_SETTING.id;
const formatCommandValue = (settings: CommandSettings, id: CommandSettingId) =>
  id === NATIVE_MCP_SETTING.id
    ? formatOnOff(settings.nativeMcpPreviews)
    : formatSettingValue(settings, id);

/** Owned persistence seams for command tests; no native manager changes happen here. */
export interface CodePreviewSettingsCommandEffects {
  readonly loadStartup: typeof loadCodePreviewStartupSettings;
  readonly saveStartup: typeof queueStartupSettingsSave;
}
const liveEffects: CodePreviewSettingsCommandEffects = {
  loadStartup: loadCodePreviewStartupSettings,
  saveStartup: queueStartupSettingsSave,
};
const loadOptions = (ctx: ExtensionCommandContext): LoadSettingsOptions => ({
  projectCwd: ctx.cwd,
  projectTrusted: isProjectTrusted(ctx),
});

/** A fresh invocation owns its configured startup snapshot, independently of running MCP. */
function commandForStartup(
  startup: CodePreviewStartupSettings,
  effects: CodePreviewSettingsCommandEffects,
): ExtensionSubcommand {
  let configured = { ...startup };
  const config = (): CommandSettings => ({ ...codePreviewSettings, ...configured });
  return settingsSubcommand<CommandSettings>({
    root: "code-previews",
    description: "Configure code previews and how tool calls look",
    title: "Code Previews",
    scopes: [{ name: "global", description: "Save global Code Previews settings" }],
    descriptors: SCRIPTED_SETTINGS.map((setting) => ({
      ...setting,
      currentValue: (settings: CommandSettings) => formatCommandValue(settings, setting.id),
    })),
    examples: ["toolCallCollapsedStyle compact", "readCollapsedLines 40", "nativeMcpPreviews on"],
    notes: (ctx) => [
      `Settings are saved in ${formatDisplayPath(getSettingsPath(), ctx.cwd)}.`,
      "Tool call appearance, preview tools, and native MCP previews take effect after /reload.",
      "Native MCP previews are global-only. Off restores builtin rendering; configure servers with /mcp.",
    ],
    config,
    status: (ctx) =>
      [
        "Code Previews settings",
        ...SCRIPTED_SETTINGS.map(
          (setting) =>
            `  ${setting.id} = ${formatCommandValue(config(), setting.id)}${setting.id === NATIVE_MCP_SETTING.id ? " (configured; requires /reload)" : ""}`,
        ),
        `MCP preview adapter in this session: ${getNativeMcpStatus().state === "owned" ? "active" : "not active"}`,
        `Settings file: ${formatDisplayPath(getSettingsPath(), ctx.cwd)}`,
      ].join("\n"),
    apply: (ctx, id, value, signal) => {
      if (id === NATIVE_MCP_SETTING.id) {
        if (value !== "on" && value !== "off")
          return Promise.resolve(Result.fail({ message: `${id} can't be set to ${value}` }));
        return effects.saveStartup({ nativeMcpPreviews: value === "on" }, signal).then(
          (saved) => {
            configured = { ...saved };
            return Result.succeed(undefined);
          },
          (error) => Result.fail({ message: formatSettingsSaveError(error) }),
        );
      }
      const previousTheme = codePreviewSettings.shikiTheme;
      const next = updateSetting(codePreviewSettings, id, value);
      // SAFETY: The shell only applies known scripted ids; the startup id was handled above.
      if (formatSettingValue(next, id as CodePreviewEditableSettingId) !== value)
        return Promise.resolve(Result.fail({ message: `${id} can't be set to ${value}` }));
      return persistSettingsChange(next, previousTheme, loadOptions(ctx)).then(
        () => Result.succeed(undefined),
        (error) => Result.fail({ message: formatSettingsSaveError(error) }),
      );
    },
    afterApply: (ctx, id) => {
      if (id === NATIVE_MCP_SETTING.id)
        notifyAtHostBoundary(ctx, "Native MCP preview changes require /reload", "info");
    },
    open: (ctx) => {
      const captured = captureHostSignal(ctx);
      if (captured["_tag"] === "Unavailable") return Promise.resolve({ _tag: "Blocked" as const });
      return openOwnedSurfacePromise<undefined>(ctx, {
        placement: "inline",
        closedValue: undefined,
        create: ({ tui, theme, keybindings, finish }) => {
          const model = createCodePreviewSettingsModel({
            theme,
            notify: (message, level) => notifyAtHostBoundary(ctx, message, level),
            done: () => finish(undefined),
            loadOptions: loadOptions(ctx),
            startupSettings: configured,
            signal: captured.signal,
            effects: {
              queueSave: persistOrdinarySettings,
              initializeSyntax: initializePanelSyntax,
              queueStartupSave: effects.saveStartup,
            },
          });
          const created = createSettingsListSurface({
            header: new Text(theme.fg("accent", theme.bold("Code Previews settings")), 1, 1),
            items: model.items,
            height: Math.min(20, model.items.length + 2),
            listTheme: managerSettingsTheme(theme),
            onChange: model.onChange,
            onCancel: model.onCancel,
            matchesKeybinding: Predicate.isFunction(keybindings?.matches)
              ? (data, id) => keybindings.matches(data, id)
              : undefined,
            requestRender: Predicate.isFunction(tui?.requestRender)
              ? () => tui.requestRender()
              : undefined,
            dim: Predicate.isFunction(theme?.fg) ? (text) => theme.fg("dim", text) : (text) => text,
          });
          model.bind(created.list);
          return created.surface;
        },
      });
    },
  });
}

/** `/code-previews settings` keeps both startup values and ordinary values fresh per invocation. */
export function codePreviewSettingsSubcommand(
  effects: CodePreviewSettingsCommandEffects = liveEffects,
): ExtensionSubcommand {
  const metadata = commandForStartup(defaultCodePreviewStartupSettings, effects);
  return {
    ...metadata,
    handler: (args, ctx) => {
      // Capture before disk I/O: Pi contexts can expose the replacement session's signal later.
      const captured = captureHostSignal(ctx);
      if (captured["_tag"] === "Unavailable") {
        notifyAtHostBoundary(ctx, "Code Previews settings aren't available right now", "warning");
        return;
      }
      const { signal } = captured;
      if (signal?.aborted) return;
      return effects.loadStartup(signal).then((startup) => {
        if (signal?.aborted) return;
        return commandForStartup(startup, effects).handler(args, ctx);
      });
    },
  };
}
