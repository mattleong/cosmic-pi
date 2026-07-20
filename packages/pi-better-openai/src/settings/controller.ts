import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import {
  FAST_SETTING_DESCRIPTORS,
  FOOTER_SETTING_DESCRIPTORS,
  IMAGE_SETTING_DESCRIPTORS,
  SETTINGS_OPTION_DESCRIPTORS,
  USAGE_SETTING_DESCRIPTORS,
  type ResolvedConfig,
} from "../config.ts";
import { modelList, type FastController } from "../fast-controller.ts";
import { redactDiagnosticValue } from "../format.ts";
import { OpenAIUsageService } from "../usage-controller.ts";
import { isRecord } from "../utils.ts";
import { settingsItemsFromDescriptors, type SettingsPickerItem } from "./items.ts";
import { createSettingsSubmenu, textPanel } from "./picker.ts";

const OPENAI_SETTINGS_COMMAND = "openai-settings";

function quoted(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t")}"`;
}

function formatDiagnosticValue(value: unknown, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    return [
      `${indent}[`,
      ...value.flatMap((entry) => formatDiagnosticValue(entry, depth + 1)),
      `${indent}]`,
    ];
  }
  if (isRecord(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return [`${indent}{}`];
    const lines = [`${indent}{`];
    for (const [key, entry] of entries) {
      const formatted = formatDiagnosticValue(entry, depth + 1);
      const prefix = `${"  ".repeat(depth + 1)}${quoted(key)}: `;
      lines.push(`${prefix}${formatted[0]?.trimStart() ?? "null"}`, ...formatted.slice(1));
    }
    lines.push(`${indent}}`);
    return lines;
  }
  const scalar =
    typeof value === "string" ? quoted(value) : value === undefined ? "undefined" : String(value);
  return [`${indent}${scalar}`];
}

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    updateContext(ctx: ExtensionContext): void;
    updateFooter(ctx: ExtensionContext): void;
    hasTerminalUI(ctx: ExtensionContext): boolean;
    formatDebugStatus(ctx: ExtensionContext): string;
    fastController: FastController;
    run<A, E>(effect: Effect.Effect<A, E, OpenAIUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  const {
    config,
    updateContext,
    updateFooter,
    hasTerminalUI,
    formatDebugStatus,
    fastController,
    run,
  } = options;
  const descriptors = [
    {
      id: "fast.enabled",
      label: "Fast mode",
      values: ["true", "false"] as const,
      description: "Request OpenAI fast mode for supported models.",
      currentValue: (_cfg: ResolvedConfig) => String(fastController.desiredActive),
    },
    ...SETTINGS_OPTION_DESCRIPTORS,
  ];

  const readRedactedConfig = (ctx: ExtensionContext) =>
    run(
      OpenAIUsageService.use((service) => service.readConfigDocument()).pipe(
        Effect.map(redactDiagnosticValue),
      ),
      ctx.signal,
    );

  const applySetting = (ctx: ExtensionContext, id: string, value: string) => {
    updateContext(ctx);
    const update =
      id === "fast.enabled"
        ? Effect.gen(function* () {
            fastController.setDesired(ctx, value === "true");
            yield* OpenAIUsageService.use((service) =>
              service.persistFast(fastController.active, fastController.desiredActive),
            );
          })
        : OpenAIUsageService.use((service) => service.updateSetting(id, value));
    return run(
      update.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            updateFooter(ctx);
            const descriptor = descriptors.find((candidate) => candidate.id === id);
            ctx.ui.notify(`${id} = ${descriptor?.currentValue(config(ctx)) ?? value}`, "info");
          }),
        ),
        Effect.catch((error) => Effect.sync(() => ctx.ui.notify(error.message, "error"))),
      ),
      ctx.signal,
    );
  };

  const usageSummary = (cfg: ResolvedConfig) =>
    cfg.usage.enabled ? `enabled · ${Math.round(cfg.usage.refreshIntervalMs / 1000)}s` : "disabled";
  const imageSummary = (cfg: ResolvedConfig) =>
    cfg.image.enabled
      ? `enabled · ${cfg.image.defaultModel} · ${cfg.image.defaultSave}/${cfg.image.outputFormat}`
      : "disabled";

  const showPicker = (ctx: ExtensionContext): Promise<void> => {
    updateContext(ctx);
    if (!hasTerminalUI(ctx)) {
      ctx.ui.notify("Better OpenAI settings require interactive TUI mode.", "warning");
      return Promise.resolve();
    }
    return readRedactedConfig(ctx)
      .catch(() => ({}))
      .then((initialRedactedConfig) => {
        let redactedConfig = initialRedactedConfig;
        return ctx.ui
          .custom((tui, theme, _keyboard, done) => {
            const writeSetting = (writeContext: ExtensionContext, id: string, value: string) => {
              void applySetting(writeContext, id, value).then(() =>
                readRedactedConfig(writeContext)
                  .catch(() => redactedConfig)
                  .then((nextRedactedConfig) => {
                    redactedConfig = nextRedactedConfig;
                    tui.requestRender();
                  }),
              );
            };
            const submenu = (
              title: string,
              items: () => SettingsPickerItem[],
              complete: () => void,
            ) => createSettingsSubmenu(title, items, ctx, complete, writeSetting);
            const fastItems = () => [
              {
                id: "fast.enabled",
                label: "Fast mode",
                currentValue: String(fastController.desiredActive),
                values: ["true", "false"],
                description: `Request OpenAI fast mode. Activates for package-supported models: ${modelList()}.`,
              },
              ...settingsItemsFromDescriptors(FAST_SETTING_DESCRIPTORS, config(ctx)),
            ];
            const diagnosticItems = (): SettingsPickerItem[] => {
              const cfg = config(ctx);
              return [
                {
                  id: "debug",
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
                    textPanel("Redacted config", formatDiagnosticValue(redactedConfig), complete),
                },
              ];
            };
            const sections = (): SettingsPickerItem[] => {
              const cfg = config(ctx);
              return [
                {
                  id: "section.fast",
                  label: "Fast mode",
                  currentValue: fastController.settingsSummary(ctx),
                  description: "Configure OpenAI fast mode and persistence.",
                  submenu: (_value, complete) =>
                    submenu("Fast mode settings", fastItems, () =>
                      complete(fastController.settingsSummary(ctx)),
                    ),
                },
                {
                  id: "section.footer",
                  label: "Footer",
                  currentValue: cfg.footer.mode,
                  description: "Configure Better OpenAI footer ownership.",
                  submenu: (_value, complete) =>
                    submenu(
                      "Footer settings",
                      () => settingsItemsFromDescriptors(FOOTER_SETTING_DESCRIPTORS, config(ctx)),
                      () => complete(config(ctx).footer.mode),
                    ),
                },
                {
                  id: "section.usage",
                  label: "Usage",
                  currentValue: usageSummary(cfg),
                  description: "Configure subscription usage fetching and display.",
                  submenu: (_value, complete) =>
                    submenu(
                      "Usage settings",
                      () => settingsItemsFromDescriptors(USAGE_SETTING_DESCRIPTORS, config(ctx)),
                      () => complete(usageSummary(config(ctx))),
                    ),
                },
                {
                  id: "section.image",
                  label: "Image tool",
                  currentValue: imageSummary(cfg),
                  description: "Configure OpenAI image generation defaults.",
                  submenu: (_value, complete) =>
                    submenu(
                      "Image tool settings",
                      () => settingsItemsFromDescriptors(IMAGE_SETTING_DESCRIPTORS, config(ctx)),
                      () => complete(imageSummary(config(ctx))),
                    ),
                },
                {
                  id: "section.diagnostics",
                  label: "Diagnostics",
                  currentValue: "debug / config",
                  description: "Show diagnostics, config paths, and redacted raw config.",
                  submenu: (_value, complete) =>
                    submenu("Diagnostics", diagnosticItems, () => complete("debug / config")),
                },
              ];
            };
            const container = new Container();
            container.addChild(
              new (class {
                render() {
                  return [
                    theme.fg("accent", theme.bold("Better OpenAI Settings")),
                    theme.fg("dim", config(ctx).configPath),
                    "",
                  ];
                }
                invalidate() {}
              })(),
            );
            const settings = new SettingsList(
              sections(),
              8,
              getSettingsListTheme(),
              (id, value) => {
                if (!id.startsWith("section.")) writeSetting(ctx, id, value);
                settings.updateValue(
                  id,
                  sections().find((item) => item.id === id)?.currentValue ?? value,
                );
                tui.requestRender();
              },
              () => done(undefined),
              { enableSearch: true },
            );
            container.addChild(settings);
            return {
              render: (width: number) => container.render(width),
              invalidate: () => container.invalidate(),
              handleInput(data: string) {
                settings.handleInput(data);
                tui.requestRender();
              },
            };
          })
          .then(() => undefined);
      });
  };

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Configure Better OpenAI",
    handler: (args, ctx) => {
      updateContext(ctx);
      const trimmed = args.trim();
      if (!trimmed) return showPicker(ctx);
      if (trimmed === "help") {
        const cfg = config(ctx);
        ctx.ui.notify(
          [
            "Better OpenAI settings",
            ...descriptors.map(
              (descriptor) =>
                `  ${descriptor.id}=${descriptor.currentValue(cfg)}  — ${descriptor.description}`,
            ),
            "",
            "Usage: /openai-settings <id> <value>",
            "       /openai-settings diagnostics",
          ].join("\n"),
          "info",
        );
        return run(Effect.void, ctx.signal);
      }
      if (trimmed === "diagnostics" || trimmed === "debug") {
        ctx.ui.notify(formatDebugStatus(ctx), "info");
        return run(Effect.void, ctx.signal);
      }
      const [id, ...parts] = trimmed.split(/\s+/);
      const value = parts.join(" ").trim();
      const descriptor = descriptors.find((candidate) => candidate.id === id);
      if (!id || !value || !descriptor) {
        ctx.ui.notify(
          id ? `Unknown setting: ${id}` : "Usage: /openai-settings <id> <value>",
          "error",
        );
        return run(Effect.void, ctx.signal);
      }
      if (descriptor.values && !(descriptor.values as readonly string[]).includes(value)) {
        ctx.ui.notify(
          `Invalid value for ${id}. Expected one of: ${descriptor.values.join(", ")}`,
          "error",
        );
        return run(Effect.void, ctx.signal);
      }
      return applySetting(ctx, id, value);
    },
  });
}
