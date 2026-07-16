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
  PET_SETTING_DESCRIPTORS,
  PET_STATES,
  USAGE_SETTING_DESCRIPTORS,
  applySettingToRawConfig,
  readRawConfig,
  type PetState,
  type ResolvedConfig,
  writeConfig,
} from "../config.ts";
import type { FastController } from "../fast-controller.ts";
import { modelList } from "../fast-controller.ts";
import { redactDiagnosticValue } from "../format.ts";
import type { PetFooterController } from "../pet-footer-controller.ts";
import { listCodexPets } from "../pets.ts";
import type { UsageController } from "../usage-controller.ts";
import {
  PET_EMPTY_VALUE,
  petConfigPickerValue,
  petPickerDescription,
  readyPetPickerValues,
  settingsItemsFromDescriptors,
  type SettingsPickerItem,
} from "./items.ts";
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
  petController: PetFooterController;
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
    petController,
  } = dependencies;

  function buildPetSettingsItems(cfg: ResolvedConfig): SettingsPickerItem[] {
    return settingsItemsFromDescriptors(PET_SETTING_DESCRIPTORS, cfg, {
      "pets.slug": {
        currentValue: petConfigPickerValue(cfg),
        values: readyPetPickerValues(petController.settingsPets),
        description: petPickerDescription(cfg, petController.settingsPets),
      },
    });
  }

  function petPreviewFromItem(item: SettingsPickerItem | undefined): PetState | undefined {
    if (
      item?.id !== "pets.state" &&
      item?.id !== "pets.thinkingState" &&
      item?.id !== "pets.toolState" &&
      item?.id !== "pets.failedToolState"
    )
      return undefined;
    const value = item.currentValue;
    return (PET_STATES as readonly string[]).includes(value) ? (value as PetState) : undefined;
  }

  function settingsSubmenu(
    title: string,
    items: () => SettingsPickerItem[],
    ctx: ExtensionContext,
    done: () => void,
    options?: Parameters<typeof createSettingsSubmenu>[5],
  ) {
    return createSettingsSubmenu(title, items, ctx, done, writeSetting, options);
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

  function petSettingsSummary(cfg: ResolvedConfig): string {
    const selected = cfg.pets.slug || (cfg.pets.enabled ? "first ready" : PET_EMPTY_VALUE);
    const status = cfg.pets.enabled ? "enabled" : "disabled";
    return `${status} · ${selected} · ${cfg.pets.placement}`;
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
        id: "section.pets",
        label: "Footer pet",
        currentValue: petSettingsSummary(cfg),
        description: "Configure footer pet visibility, animation-state mapping, and size.",
        submenu: (_value, done) => {
          petController.setSettingsPreviewActive(ctx, true);
          return settingsSubmenu(
            "Footer pet settings",
            () => buildPetSettingsItems(config(ctx)),
            ctx,
            () => done(petSettingsSummary(config(ctx))),
            {
              onSelection: (item) => {
                const previewState = petPreviewFromItem(item);
                if (previewState !== petController.previewState) {
                  petController.setPreviewState(previewState);
                  updateFooter(ctx);
                }
              },
              onClose: () => {
                petController.setPreviewState(undefined);
                petController.setSettingsPreviewActive(ctx, false);
                updateFooter(ctx);
              },
              renderExtra: (width) => petController.renderSettingsPreview(ctx, width),
            },
          );
        },
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
    const bool = rawValue === "true";
    if (id === "fast.enabled") fastController.setDesired(ctx, bool);
    const petKey = id.startsWith("pets.") ? id.slice("pets.".length) : undefined;
    const nextRawConfig = applySettingToRawConfig(current, id, rawValue, {
      persistState: cfg.persistState,
      active: fastController.active,
      desiredActive: fastController.desiredActive,
      petEmptyValue: PET_EMPTY_VALUE,
    });
    if (petKey) {
      if (petKey === "enabled" || petKey === "sizeCells" || petKey === "slug")
        petController.invalidateLoadKey();
      if (petKey === "placement" || petKey === "sizeCells" || petKey === "slug")
        petController.resetRenderCache();
      if (petKey === "idleEmotes" || petKey === "idleEmoteIntervalMs")
        petController.stopIdleEmotes();
    }
    writeConfig(cfg.configPath, nextRawConfig);
    const next = refresh(ctx);
    if (id === "pets.enabled" || id === "pets.sizeCells" || id === "pets.slug")
      void petController.refresh(ctx, next);
    if (id.startsWith("usage.")) usageController.restartAfterSettingsChange(ctx, next);
    updateFooter(ctx);
  }

  async function showSettingsPicker(ctx: ExtensionContext): Promise<void> {
    if (!hasTerminalUI(ctx)) {
      ctx.ui.notify("Better OpenAI settings require interactive TUI mode.", "warning");
      return;
    }
    try {
      petController.settingsPets = await listCodexPets();
    } catch {
      petController.settingsPets = [];
    }
    try {
      await ctx.ui.custom((tui, theme, _kb, done) => {
        petController.setSettingsRenderRequest(() => tui.requestRender());
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
              buildSettingsSections(ctx, config(ctx)).find((item) => item.id === id)
                ?.currentValue ?? newValue,
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
    } finally {
      petController.setSettingsRenderRequest(undefined);
      petController.setPreviewState(undefined);
      petController.setSettingsPreviewActive(ctx, false);
      updateFooter(ctx);
    }
  }

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Open Better OpenAI settings picker",
    handler: async (_args, ctx) => {
      await showSettingsPicker(ctx);
    },
  });
}
