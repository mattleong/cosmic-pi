import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Predicate from "effect/Predicate";
import { invokeHostCallback, redactDiagnosticValue } from "pi-cosmic-core";
import { registerSettingsCommand } from "pi-cosmic-ui/boundary/host-settings-command";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import { listDetailFrame } from "pi-cosmic-ui/manager/list-detail-shell";
import { TextPanelComponent } from "pi-cosmic-ui/manager/panel";
import {
  createSettingsGroupSubmenu,
  managerSettingsTheme,
  createSettingsListSurface,
  settingsItemsFromDescriptors,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import { safeHostSignal, safeHostUi } from "../boundary/host-ui.ts";
import {
  COMPACTION_SETTING_DESCRIPTORS,
  FAST_SETTING_DESCRIPTORS,
  IMAGE_SETTING_DESCRIPTORS,
  SETTINGS_OPTION_DESCRIPTORS,
  USAGE_SETTING_DESCRIPTORS,
} from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { settingsSummary, type FastSnapshot } from "../fast/controller.ts";
import { FastModeService } from "../fast/service.ts";
import { OpenAIUsageService } from "../usage/controller.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedConfig | undefined;
    updateContext(ctx: ExtensionContext): void;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    fastProjection: MutableRef.MutableRef<FastSnapshot>;
    resetFastRoutingTransport(ctx: ExtensionContext): void;
    run<A, E>(
      effect: Effect.Effect<A, E, OpenAIUsageService | FastModeService>,
      signal?: AbortSignal,
    ): Promise<A>;
  },
): void {
  const {
    config,
    updateContext,
    updateFooter,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport,
    run,
  } = options;
  const fastEnabledDescriptor = {
    id: "fast.enabled",
    label: "Fast mode",
    values: ["true", "false"] as const,
    description: "Request OpenAI fast mode for any openai or openai-codex model.",
    currentValue: (_cfg: ResolvedConfig) => String(MutableRef.get(fastProjection).desiredActive),
  };
  const descriptors = [fastEnabledDescriptor, ...SETTINGS_OPTION_DESCRIPTORS];

  const readRedactedConfig = (ctx: ExtensionContext) =>
    run(
      OpenAIUsageService.use((service) => service.readConfigDocument()).pipe(
        Effect.map((value) => redactDiagnosticValue(value)),
      ),
      safeHostSignal(ctx),
    );

  registerSettingsCommand(pi, {
    command: "openai-settings",
    description: "Configure Better OpenAI",
    title: "Better OpenAI",
    descriptors,
    examples: ["fast.enabled true", "usage.refreshIntervalMs 30000"],
    config,
    diagnostics: formatDebugStatus,
    onInvoke: updateContext,
    signal: "optional",
    apply: (ctx, id, value, signal) =>
      run(
        Effect.gen(function* () {
          if (id !== "fast.enabled")
            return yield* OpenAIUsageService.use((service) => service.updateSetting(id, value));
          yield* FastModeService.use((service) => service.setDesired(ctx, value === "true"));
          yield* Effect.sync(() => resetFastRoutingTransport(ctx));
        }).pipe(Effect.result),
        signal,
      ),
    afterApply: updateFooter,
    open: (ctx, session) =>
      readRedactedConfig(ctx)
        .catch(() => ({}))
        .then((initialRedactedConfig) => {
          let redactedConfig = initialRedactedConfig;
          const initialConfig = session.config();
          if (!initialConfig) return { _tag: "Blocked" } as const;
          // One snapshot per picker session, refreshed after each write.
          let cfg = initialConfig;
          return openOwnedSurfacePromise<undefined>(ctx, {
            placement: "inline",
            closedValue: undefined,
            create: ({ tui, theme, keybindings, finish }) => {
              let outerList: SettingsList | undefined;
              const textPanel = (title: string, lines: string[], complete: () => void) =>
                new TextPanelComponent({
                  theme,
                  title,
                  lines,
                  done: complete,
                  frame: listDetailFrame(theme),
                  dismiss: "back-keys",
                });
              const diagnosticItems = (): SettingItem[] => [
                {
                  id: "diagnostics",
                  label: "Debug info",
                  currentValue: "open",
                  description: "Show Better OpenAI diagnostics.",
                  submenu: (_value, complete) =>
                    textPanel("Debug info", formatDebugStatus(ctx).split("\n"), complete),
                },
                {
                  id: "config.paths",
                  label: "Config paths",
                  currentValue: cfg.configPath,
                  description: `Selected: ${cfg.configPath}\nProject: ${cfg.projectConfigPath}\nGlobal: ${cfg.globalConfigPath}`,
                  submenu: (_value, complete) =>
                    textPanel(
                      "Config paths",
                      [
                        `Selected: ${cfg.configPath}`,
                        `Project:  ${cfg.projectConfigPath}`,
                        `Global:   ${cfg.globalConfigPath}`,
                      ],
                      complete,
                    ),
                },
                {
                  id: "config.print",
                  label: "Redacted config",
                  currentValue: "open",
                  description: "Show the selected raw config with sensitive fields redacted.",
                  submenu: (_value, complete) =>
                    textPanel(
                      "Redacted config",
                      JSON.stringify(redactedConfig, null, 2).split("\n"),
                      complete,
                    ),
                },
              ];
              const groups = [
                {
                  id: "section.fast",
                  label: "Fast mode",
                  description: "Configure OpenAI fast mode and persistence.",
                  submenuTitle: "Fast mode settings",
                  items: () =>
                    settingsItemsFromDescriptors(
                      [fastEnabledDescriptor, ...FAST_SETTING_DESCRIPTORS],
                      cfg,
                    ),
                  summary: () => settingsSummary(ctx, MutableRef.get(fastProjection)),
                },
                {
                  id: "section.compaction",
                  label: "Compaction",
                  description: "Use OpenAI native compaction when Pi triggers compaction.",
                  submenuTitle: "Compaction settings",
                  items: () => settingsItemsFromDescriptors(COMPACTION_SETTING_DESCRIPTORS, cfg),
                  summary: () => (cfg.compaction.enabled ? "OpenAI native" : "Pi default"),
                },
                {
                  id: "section.usage",
                  label: "Usage",
                  description:
                    "Configure usage refresh details. Footer visibility is in /cosmic-ui.",
                  submenuTitle: "Usage settings",
                  items: () => settingsItemsFromDescriptors(USAGE_SETTING_DESCRIPTORS, cfg),
                  summary: () => `${Math.round(cfg.usage.refreshIntervalMs / 1000)}s refresh`,
                },
                {
                  id: "section.image",
                  label: "Image tool",
                  description: "Configure OpenAI image generation defaults.",
                  submenuTitle: "Image tool settings",
                  items: () => settingsItemsFromDescriptors(IMAGE_SETTING_DESCRIPTORS, cfg),
                  summary: () =>
                    cfg.image.enabled
                      ? `enabled · ${cfg.image.defaultModel} · ${cfg.image.defaultSave}/${cfg.image.outputFormat}`
                      : "disabled",
                },
                {
                  id: "section.diagnostics",
                  label: "Diagnostics",
                  description: "Show diagnostics, config paths, and redacted raw config.",
                  submenuTitle: "Diagnostics",
                  items: diagnosticItems,
                  summary: () => "debug / config",
                },
              ];
              const sections = () =>
                groups.map(
                  (group): SettingsSurfaceItem => ({
                    kind: "group",
                    id: group.id,
                    label: group.label,
                    currentValue: group.summary(),
                    description: group.description,
                    submenu: (_value, complete) =>
                      createSettingsGroupSubmenu({
                        title: group.submenuTitle,
                        items: group.items,
                        onChange: writeSetting,
                        done: complete,
                        summary: group.summary,
                        listTheme: managerSettingsTheme(theme),
                      }),
                  }),
                );
              const reconcilePicker = () =>
                invokeHostCallback(() => {
                  cfg = session.config() ?? cfg;
                  if (outerList)
                    for (const section of sections())
                      outerList.updateValue(section.id, section.currentValue);
                  tui.requestRender();
                }, undefined);
              function writeSetting(id: string, value: string): Promise<void> {
                return session.apply(id, value).then(() => {
                  reconcilePicker();
                  void readRedactedConfig(ctx)
                    .catch(() => redactedConfig)
                    .then((nextRedactedConfig) => {
                      redactedConfig = nextRedactedConfig;
                      safeHostUi(() => tui.requestRender());
                    })
                    .catch(() => undefined);
                });
              }
              const created = createSettingsListSurface({
                header: {
                  render: () => [
                    theme.fg("accent", theme.bold("Better OpenAI Settings")),
                    theme.fg("dim", cfg.configPath),
                    "",
                  ],
                  invalidate() {},
                },
                items: sections(),
                height: 8,
                listTheme: managerSettingsTheme(theme),
                onChange: reconcilePicker,
                onCancel: () => finish(undefined),
                matchesKeybinding: Predicate.isFunction(keybindings?.matches)
                  ? (data, id) => keybindings.matches(data, id)
                  : undefined,
                requestRender: () => safeHostUi(() => tui.requestRender()),
                dim: (text) => theme.fg("dim", text),
                bridge: {
                  invoke: invokeHostCallback,
                  afterInput: () => safeHostUi(() => tui.requestRender()),
                },
              });
              outerList = created.list;
              return created.surface;
            },
          });
        }),
  });
}
