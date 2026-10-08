import * as Result from "effect/Result";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  formatDisplayPath,
  isProjectTrusted,
  notifyAtHostBoundary,
  type ExtensionSubcommand,
} from "pi-cosmic-core";
import { openSettingsList, settingsSubcommand } from "pi-cosmic-ui/boundary/host-settings-command";
import {
  hasCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "../application/capability";
import {
  CODE_PREVIEW_SETTING_KEYS,
  type CodePreviewEditableSettingId,
  type CodePreviewSettings,
} from "../config/schema";
import { codePreviewSettings } from "../config/state";
import {
  formatSettingsSaveError,
  getSettingsPath,
  type LoadSettingsOptions,
} from "../config/store";
import { formatSettingValue, updateSetting } from "../config/values";
import { createCodePreviewSettingsModel, persistSettingsChange } from "./panel";
import { SETTING_ITEM_DEFINITIONS, type SettingItemDefinition } from "./ui/registry";

/** Settings a command can change directly; groups, tools, and the reset row are list-only. */
const SCRIPTED_SETTINGS = CODE_PREVIEW_SETTING_KEYS.flatMap((id) => {
  if (id === "tools") return [];
  const { description, values }: SettingItemDefinition = SETTING_ITEM_DEFINITIONS[id];
  return [{ id, description, ...(values && { values: [...values] }) }];
});

/** Settings are known only once a session has loaded them; before that, edits would guess. */
const config = (): CodePreviewSettings | undefined =>
  hasCodePreviewSessionCapability() ? codePreviewSettings : undefined;

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
      // An edit made before the session loads its settings would overwrite the file with guesses.
      if (!config()) return rejectInactiveCodePreviewSession("settings");
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
    open: (ctx, session) => {
      if (!session.config()) return Promise.resolve({ _tag: "Blocked" as const });
      return openSettingsList(ctx, ({ theme, finish }) => {
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
      });
    },
  });
}
