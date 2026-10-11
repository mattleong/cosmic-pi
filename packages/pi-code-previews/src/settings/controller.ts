import * as Result from "effect/Result";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  formatDisplayPath,
  isProjectTrusted,
  notifyAtHostBoundary,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import {
  openSettingsList,
  settingsSubcommand,
  withInvocationAuthority,
} from "pi-cosmic-ui/boundary/host-settings-command";
import {
  captureCodePreviewSessionCapability,
  hasCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "../application/capability";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import {
  formatSettingsSaveError,
  getSettingsPath,
  type LoadSettingsOptions,
} from "../config/store";
import { formatSettingValue, updateSetting } from "../config/values";
import { createCodePreviewSettingsModel, persistSettingsChange } from "./panel";
import { SETTING_ITEM_DEFINITIONS, type SettingItemDefinition } from "./ui/registry";

const SCRIPTED_SETTINGS = CODE_PREVIEW_SETTING_KEYS.flatMap((id) => {
  if (id === "tools") return [];
  const { description, values }: SettingItemDefinition = SETTING_ITEM_DEFINITIONS[id];
  return [{ id, description, ...(values && { values: [...values] }) }];
});

const config = (): CodePreviewSettings | undefined =>
  hasCodePreviewSessionCapability() ? codePreviewSettings : undefined;

const loadOptions = (ctx: ExtensionCommandContext): LoadSettingsOptions => ({
  projectCwd: ctx.cwd,
  projectTrusted: isProjectTrusted(ctx),
});

const captureAuthority = (): (() => boolean) => {
  const captured = captureCodePreviewSessionCapability();
  return () => captureCodePreviewSessionCapability() === captured;
};

export function codePreviewSettingsSubcommand(): ExtensionSubcommand {
  return withInvocationAuthority(captureAuthority, (isCurrent) =>
    codePreviewSettingsCommand(isCurrent),
  );
}

function codePreviewSettingsCommand(isCurrent: () => boolean): ExtensionSubcommand {
  return settingsSubcommand<CodePreviewSettings>({
    root: "code-previews",
    isCurrent,
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
    status: (ctx) => {
      const current = config();
      if (!current) return "Code Previews settings aren't available right now";
      return [
        "Code Previews settings",
        ...SCRIPTED_SETTINGS.map(
          (setting) => `  ${setting.id} = ${formatSettingValue(current, setting.id)}`,
        ),
        `Settings file: ${formatDisplayPath(getSettingsPath(), ctx.cwd)}`,
      ].join("\n");
    },
    apply: (ctx, id, value) => {
      if (!config()) return rejectInactiveCodePreviewSession("settings");
      const setting = SCRIPTED_SETTINGS.find((entry) => entry.id === id);
      const previousTheme = codePreviewSettings.shikiTheme;
      const next = updateSetting(codePreviewSettings, id, value);
      if (!setting || formatSettingValue(next, setting.id) !== value)
        return Promise.resolve(Result.fail({ message: `${id} can't be set to ${value}` }));
      return persistSettingsChange(next, previousTheme, loadOptions(ctx)).then(
        () => Result.succeed(undefined),
        (error) => Result.fail({ message: formatSettingsSaveError(error) }),
      );
    },
    open: (ctx, session) => {
      if (!session.config()) return Promise.resolve({ _tag: "Blocked" as const });
      return openSettingsList(
        ctx,
        ({ theme, finish }) => {
          const model = createCodePreviewSettingsModel({
            theme,
            notify: (message, level) => notifyAtHostBoundary(ctx, message, level),
            done: () => finish(undefined),
            loadOptions: loadOptions(ctx),
          });
          return {
            header: "Code Previews settings",
            items: model.items,
            height: Math.min(20, model.items.length + 2),
            onChange: model.onChange,
            onCancel: model.onCancel,
            onList: model.bind,
          };
        },
        isCurrent,
      );
    },
  });
}
