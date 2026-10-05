import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { constVoid } from "effect/Function";
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
import type { CodePreviewEditableSettingId, CodePreviewSettings } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import {
  formatSettingsSaveError,
  getSettingsPath,
  queueSettingsSave as persistOrdinarySettings,
} from "../config/store";
import { formatSettingValue, updateSetting } from "../config/values";
import { initializeShiki as initializePanelSyntax } from "../syntax/shiki";
import { createCodePreviewSettingsModel, persistSettingsChange } from "./panel";
import { SETTING_ITEM_DEFINITIONS, type SettingItemDefinition } from "./ui/registry";

/** Settings a command can change directly; groups, tools, and the reset row are list-only. */
const SCRIPTED_SETTINGS = Object.entries(SETTING_ITEM_DEFINITIONS).flatMap(
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
);

const config = (): CodePreviewSettings => codePreviewSettings;

const loadOptions = (ctx: ExtensionCommandContext): LoadSettingsOptions => ({
  projectCwd: ctx.cwd,
  projectTrusted: isProjectTrusted(ctx),
});

/** Preview appearance includes native MCP; Pi retains server management through /mcp. */
export function codePreviewSettingsSubcommand(): ExtensionSubcommand {
  return settingsSubcommand<CodePreviewSettings>({
    root: "code-previews",
    description: "Configure code previews and how tool calls look",
    title: "Code Previews",
    scopes: [{ name: "global", description: "Save global Code Previews settings" }],
    descriptors: SCRIPTED_SETTINGS.map((setting) => ({
      ...setting,
      currentValue: (settings: CodePreviewSettings) => formatSettingValue(settings, setting.id),
    })),
    examples: ["toolCallCollapsedStyle compact", "readCollapsedLines 40"],
    notes: (ctx) => [
      `Settings are saved in ${formatDisplayPath(getSettingsPath(), ctx.cwd)}.`,
      "Tool call appearance and preview tools take effect after /reload.",
      "Native MCP calls use this appearance; manage servers through /mcp.",
    ],
    config,
    status: (ctx) =>
      [
        "Code Previews settings",
        ...SCRIPTED_SETTINGS.map(
          (setting) => `  ${setting.id} = ${formatSettingValue(config(), setting.id)}`,
        ),
        `Settings file: ${formatDisplayPath(getSettingsPath(), ctx.cwd)}`,
      ].join("\n"),
    apply: (ctx, id, value) => {
      const previousTheme = codePreviewSettings.shikiTheme;
      const next = updateSetting(codePreviewSettings, id, value);
      // SAFETY: The shell only applies known scripted ids from the ordinary registry.
      if (formatSettingValue(next, id as CodePreviewEditableSettingId) !== value)
        return Promise.resolve(Result.fail({ message: `${id} can't be set to ${value}` }));
      return persistSettingsChange(next, previousTheme, loadOptions(ctx)).then(
        () => Result.succeed(undefined),
        (error) => Result.fail({ message: formatSettingsSaveError(error) }),
      );
    },
    afterApply: constVoid,
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
            effects: {
              queueSave: persistOrdinarySettings,
              initializeSyntax: initializePanelSyntax,
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
