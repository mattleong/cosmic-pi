import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import {
  FAST_SETTING_DESCRIPTORS,
  FOOTER_SETTING_DESCRIPTORS,
  IMAGE_SETTING_DESCRIPTORS,
  USAGE_SETTING_DESCRIPTORS,
  applySettingToRawConfig,
  readRawConfig,
  type ResolvedConfig,
  writeConfig,
} from "../config.ts";
import { modelList, type FastController } from "../fast-controller.ts";
import { redactDiagnosticValue } from "../format.ts";
import type { UsageController } from "../usage-controller.ts";
import { settingsItemsFromDescriptors, type SettingsPickerItem } from "./items.ts";
import { createSettingsSubmenu, textPanel } from "./picker.ts";

const OPENAI_SETTINGS_COMMAND = "openai-settings";

export interface SettingsControllerDependencies {
  config(ctx: ExtensionContext): ResolvedConfig;
  refresh(ctx: ExtensionContext): ResolvedConfig;
  updateFooter(ctx: ExtensionContext): void;
  hasTerminalUI(ctx: ExtensionContext): boolean;
  formatDebugStatus(ctx: ExtensionContext): string;
  fastController: FastController;
  usageController: UsageController;
}

export function registerSettingsController(
  pi: ExtensionAPI,
  dependencies: SettingsControllerDependencies,
): void {
  const {
    config,
    refresh,
    updateFooter,
    hasTerminalUI,
    formatDebugStatus,
    fastController,
    usageController,
  } = dependencies;

  function settingsSubmenu(
    title: string,
    items: () => SettingsPickerItem[],
    ctx: ExtensionContext,
    done: () => void,
  ) {
    return createSettingsSubmenu(title, items, ctx, done, writeSetting);
  }

  function usageSettingsSummary(cfg: ResolvedConfig): string {
    return cfg.usage.enabled
      ? `enabled · ${Math.round(cfg.usage.refreshIntervalMs / 1000)}s`
      : "disabled";
  }

  function imageSettingsSummary(cfg: ResolvedConfig): string {
    return cfg.image.enabled
      ? `enabled · ${cfg.image.defaultModel} · ${cfg.image.defaultSave}/${cfg.image.outputFormat}`
      : "disabled";
  }

  function buildFastSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "fast.enabled",
        label: "Fast mode",
        currentValue: String(fastController.desiredActive),
        values: ["true", "false"],
        description: `Request OpenAI fast mode. Activates for package-supported models: ${modelList()}.`,
      },
      ...settingsItemsFromDescriptors(FAST_SETTING_DESCRIPTORS, cfg),
    ];
  }

  function buildDiagnosticsSettingsItems(
    ctx: ExtensionContext,
    cfg: ResolvedConfig,
  ): SettingsPickerItem[] {
    return [
      {
        id: "debug",
        label: "Debug info",
        currentValue: "open",
        description: "Show Better OpenAI diagnostics.",
        submenu: (_value, done) =>
          textPanel("Debug info", formatDebugStatus(ctx).split("\n"), () => done()),
      },
      {
        id: "config.path",
        label: "Config path",
        currentValue: cfg.configPath,
        description: `Project: ${cfg.projectConfigPath}\nGlobal: ${cfg.globalConfigPath}`,
      },
      {
        id: "config.print",
        label: "Print config",
        currentValue: "open",
        description: "Show the selected config JSON with sensitive fields redacted.",
        submenu: (_value, done) =>
          textPanel(
            "Config",
            JSON.stringify(redactDiagnosticValue(readRawConfig(cfg.configPath)), null, 2).split(
              "\n",
            ),
            () => done(),
          ),
      },
    ];
  }

  function buildSettingsSections(ctx: ExtensionContext, cfg: ResolvedConfig): SettingsPickerItem[] {
    return [
      {
        id: "section.fast",
        label: "Fast mode",
        currentValue: fastController.settingsSummary(ctx),
        description: "Configure OpenAI fast mode and persistence.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Fast mode settings",
            () => buildFastSettingsItems(config(ctx)),
            ctx,
            () => done(fastController.settingsSummary(ctx)),
          ),
      },
      {
        id: "section.footer",
        label: "Footer",
        currentValue: cfg.footer.mode,
        description: "Configure Better OpenAI footer ownership.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Footer settings",
            () => settingsItemsFromDescriptors(FOOTER_SETTING_DESCRIPTORS, config(ctx)),
            ctx,
            () => done(config(ctx).footer.mode),
          ),
      },
      {
        id: "section.usage",
        label: "Usage",
        currentValue: usageSettingsSummary(cfg),
        description: "Configure subscription usage fetching and display.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Usage settings",
            () => settingsItemsFromDescriptors(USAGE_SETTING_DESCRIPTORS, config(ctx)),
            ctx,
            () => done(usageSettingsSummary(config(ctx))),
          ),
      },
      {
        id: "section.image",
        label: "Image tool",
        currentValue: imageSettingsSummary(cfg),
        description: "Configure OpenAI image generation defaults.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Image tool settings",
            () => settingsItemsFromDescriptors(IMAGE_SETTING_DESCRIPTORS, config(ctx)),
            ctx,
            () => done(imageSettingsSummary(config(ctx))),
          ),
      },
      {
        id: "section.diagnostics",
        label: "Diagnostics",
        currentValue: "debug / config",
        description: "Show Better OpenAI diagnostics and raw config details.",
        submenu: (_value, done) =>
          settingsSubmenu(
            "Diagnostics",
            () => buildDiagnosticsSettingsItems(ctx, config(ctx)),
            ctx,
            () => done("debug / config"),
          ),
      },
    ];
  }

  function writeSetting(ctx: ExtensionContext, id: string, rawValue: string): void {
    const cfg = refresh(ctx);
    const current = readRawConfig(cfg.configPath);
    if (id === "fast.enabled") fastController.setDesired(ctx, rawValue === "true");
    const nextRawConfig = applySettingToRawConfig(current, id, rawValue, {
      persistState: cfg.persistState,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
    });
    writeConfig(cfg.configPath, nextRawConfig);
    const next = refresh(ctx);
    if (id.startsWith("usage.")) usageController.restartAfterSettingsChange(ctx, next);
    updateFooter(ctx);
  }

  async function showSettingsPicker(ctx: ExtensionContext): Promise<void> {
    if (!hasTerminalUI(ctx)) {
      ctx.ui.notify("Better OpenAI settings require interactive TUI mode.", "warning");
      return;
    }
    await ctx.ui.custom((tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(
        new (class {
          render(_width: number) {
            const cfg = config(ctx);
            return [
              theme.fg("accent", theme.bold("Better OpenAI Settings")),
              theme.fg("dim", cfg.configPath),
              "",
            ];
          }
          invalidate() {}
        })(),
      );
      const settingsList = new SettingsList(
        buildSettingsSections(ctx, refresh(ctx)),
        8,
        getSettingsListTheme(),
        (id, newValue) => {
          if (!id.startsWith("section.")) writeSetting(ctx, id, newValue);
          settingsList.updateValue(
            id,
            buildSettingsSections(ctx, config(ctx)).find((item) => item.id === id)?.currentValue ??
              newValue,
          );
          tui.requestRender();
        },
        () => done(undefined),
        { enableSearch: true },
      );
      container.addChild(settingsList);
      return {
        render(width: number) {
          return container.render(width);
        },
        invalidate() {
          container.invalidate();
        },
        handleInput(data: string) {
          settingsList.handleInput(data);
          tui.requestRender();
        },
      };
    });
  }

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Open Better OpenAI settings picker",
    handler: async (_args, ctx) => {
      await showSettingsPicker(ctx);
    },
  });
}
