import { isFunctionValue, isStringValue } from "pi-cosmic-core";
import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import * as Predicate from "effect/Predicate";
import {
  completeSettingsArguments,
  dispatchSettingsCommand,
  redactDiagnosticValue,
} from "pi-cosmic-core";
import {
  createSettingsListSurface,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import { ignoreHostUi, safeHostSignal, safeHostUi } from "../boundary/host-ui.ts";
import {
  COMPACTION_SETTING_DESCRIPTORS,
  FAST_SETTING_DESCRIPTORS,
  FOOTER_SETTING_DESCRIPTORS,
  IMAGE_SETTING_DESCRIPTORS,
  SETTINGS_OPTION_DESCRIPTORS,
  USAGE_SETTING_DESCRIPTORS,
  type ResolvedConfig,
} from "../config/index.ts";
import { modelList, settingsSummary, type FastSnapshot } from "../fast/controller.ts";
import { FastModeService } from "../fast/service.ts";
import { OpenAIUsageService } from "../usage/index.ts";
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

function formatDiagnosticValue<ValueInput>(value: ValueInput, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}[]`];
    return [
      `${indent}[`,
      ...value.flatMap((entry) => formatDiagnosticValue(entry, depth + 1)),
      `${indent}]`,
    ];
  }
  if (Predicate.isObject(value)) {
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
  const scalar = isStringValue(value)
    ? quoted(value)
    : value === undefined
      ? "undefined"
      : String(value);
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
    fastProjection: MutableRef.MutableRef<FastSnapshot>;
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
    hasTerminalUI,
    formatDebugStatus,
    fastProjection,
    run,
  } = options;
  const descriptors = [
    {
      id: "fast.enabled",
      label: "Fast mode",
      values: ["true", "false"] as const,
      description: "Request OpenAI fast mode for supported models.",
      currentValue: (_cfg: ResolvedConfig) => String(MutableRef.get(fastProjection).desiredActive),
    },
    ...SETTINGS_OPTION_DESCRIPTORS,
  ];

  const readRedactedConfig = (ctx: ExtensionContext) =>
    run(
      OpenAIUsageService.use((service) => service.readConfigDocument()).pipe(
        Effect.map((value) => redactDiagnosticValue(value)),
      ),
      safeHostSignal(ctx),
    );

  const applySetting = (ctx: ExtensionContext, id: string, value: string) => {
    updateContext(ctx);
    const update = Effect.gen(function* () {
      if (id === "fast.enabled") {
        yield* FastModeService.use((service) => service.setDesired(ctx, value === "true"));
        return;
      }
      yield* OpenAIUsageService.use((service) => service.updateSetting(id, value));
    });
    return run(
      update.pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            yield* ignoreHostUi("settings.render", () => updateFooter(ctx));
            yield* ignoreHostUi("settings.notify", () => {
              const descriptor = descriptors.find((candidate) => candidate.id === id);
              ctx.ui.notify(`${id} = ${descriptor?.currentValue(config(ctx)) ?? value}`, "info");
            });
          }),
        ),
        Effect.catch((error) =>
          ignoreHostUi("settings.notify.error", () => ctx.ui.notify(error.message, "error")),
        ),
        Effect.asVoid,
      ),
      safeHostSignal(ctx),
    );
  };

  const compactionSummary = (cfg: ResolvedConfig) =>
    cfg.compaction.enabled ? "OpenAI native" : "Pi default";
  const usageSummary = (cfg: ResolvedConfig) =>
    cfg.usage.enabled ? `enabled · ${Math.round(cfg.usage.refreshIntervalMs / 1000)}s` : "disabled";
  const imageSummary = (cfg: ResolvedConfig) =>
    cfg.image.enabled
      ? `enabled · ${cfg.image.defaultModel} · ${cfg.image.defaultSave}/${cfg.image.outputFormat}`
      : "disabled";

  const showPicker = (ctx: ExtensionContext): Promise<void> => {
    updateContext(ctx);
    if (!hasTerminalUI(ctx)) {
      safeHostUi(() =>
        ctx.ui.notify("Better OpenAI settings require interactive TUI mode.", "warning"),
      );
      return Promise.resolve();
    }
    return readRedactedConfig(ctx)
      .catch(() => ({}))
      .then((initialRedactedConfig) => {
        let redactedConfig = initialRedactedConfig;
        return ctx.ui
          .custom((tui, theme, keyboard, done) => {
            const writeSetting = (writeContext: ExtensionContext, id: string, value: string) => {
              void applySetting(writeContext, id, value).then(() =>
                readRedactedConfig(writeContext)
                  .catch(() => redactedConfig)
                  .then((nextRedactedConfig) => {
                    redactedConfig = nextRedactedConfig;
                    safeHostUi(() => tui.requestRender());
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
                currentValue: String(MutableRef.get(fastProjection).desiredActive),
                values: ["true", "false"],
                description: `Request OpenAI fast mode. Activates for package-supported models: ${modelList()}.`,
              },
              ...settingsItemsFromDescriptors(FAST_SETTING_DESCRIPTORS, config(ctx)),
            ];
            const diagnosticItems = (): SettingsPickerItem[] => {
              const cfg = config(ctx);
              return [
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
                    textPanel("Redacted config", formatDiagnosticValue(redactedConfig), complete),
                },
              ];
            };
            const sections = (): (SettingsPickerItem & SettingsSurfaceItem)[] => {
              const cfg = config(ctx);
              return [
                {
                  kind: "group",
                  id: "section.fast",
                  label: "Fast mode",
                  currentValue: settingsSummary(ctx, MutableRef.get(fastProjection)),
                  description: "Configure OpenAI fast mode and persistence.",
                  submenu: (_value, complete) =>
                    submenu("Fast mode settings", fastItems, () =>
                      complete(settingsSummary(ctx, MutableRef.get(fastProjection))),
                    ),
                },
                {
                  kind: "group",
                  id: "section.compaction",
                  label: "Compaction",
                  currentValue: compactionSummary(cfg),
                  description: "Use OpenAI native compaction when Pi triggers compaction.",
                  submenu: (_value, complete) =>
                    submenu(
                      "Compaction settings",
                      () =>
                        settingsItemsFromDescriptors(COMPACTION_SETTING_DESCRIPTORS, config(ctx)),
                      () => complete(compactionSummary(config(ctx))),
                    ),
                },
                {
                  kind: "group",
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
                  kind: "group",
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
                  kind: "group",
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
                  kind: "group",
                  id: "section.diagnostics",
                  label: "Diagnostics",
                  currentValue: "debug / config",
                  description: "Show diagnostics, config paths, and redacted raw config.",
                  submenu: (_value, complete) =>
                    submenu("Diagnostics", diagnosticItems, () => complete("debug / config")),
                },
              ];
            };
            return createSettingsListSurface({
              header: new (class {
                render() {
                  return [
                    theme.fg("accent", theme.bold("Better OpenAI Settings")),
                    theme.fg("dim", config(ctx).configPath),
                    "",
                  ];
                }
                invalidate() {}
              })(),
              items: sections(),
              height: 8,
              listTheme: getSettingsListTheme(),
              onChange: (id, value, list) => {
                writeSetting(ctx, id, value);
                list.updateValue(
                  id,
                  sections().find((item) => item.id === id)?.currentValue ?? value,
                );
                safeHostUi(() => tui.requestRender());
              },
              onCancel: () => done(undefined),
              matchesKeybinding: isFunctionValue(keyboard?.matches)
                ? (data, id) => keyboard.matches(data, id)
                : undefined,
              requestRender: () => safeHostUi(() => tui.requestRender()),
              dim: (text) => theme.fg("dim", text),
              bridge: { afterInput: () => safeHostUi(() => tui.requestRender()) },
            }).surface;
          })
          .then(() => undefined);
      });
  };

  pi.registerCommand(OPENAI_SETTINGS_COMMAND, {
    description: "Configure Better OpenAI",
    getArgumentCompletions: (prefix) =>
      completeSettingsArguments(prefix, descriptors, [
        { value: "help", label: "help", description: "Show setting ids and usage" },
        {
          value: "diagnostics",
          label: "diagnostics",
          description: "Show Better OpenAI diagnostics",
        },
      ]),
    handler: (args, ctx) => {
      updateContext(ctx);
      const dispatch = dispatchSettingsCommand(args, descriptors);
      switch (dispatch._tag) {
        case "OpenInteractive":
          return showPicker(ctx);
        case "Help": {
          const cfg = config(ctx);
          safeHostUi(() =>
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
            ),
          );
          return run(Effect.void, safeHostSignal(ctx));
        }
        case "Diagnostics":
          safeHostUi(() => ctx.ui.notify(formatDebugStatus(ctx), "info"));
          return run(Effect.void, safeHostSignal(ctx));
        case "Invalid":
          safeHostUi(() =>
            ctx.ui.notify(
              dispatch.reason === "invalid-value"
                ? `Invalid value for ${dispatch.id}. Expected one of: ${dispatch.allowedValues.join(", ")}`
                : dispatch.reason === "missing-value"
                  ? `Missing value for ${dispatch.id}. Usage: /openai-settings <id> <value>`
                  : `Unknown setting: ${dispatch.id}`,
              "error",
            ),
          );
          return run(Effect.void, safeHostSignal(ctx));
        case "Apply":
          return applySetting(ctx, dispatch.id, dispatch.value);
      }
    },
  });
}
