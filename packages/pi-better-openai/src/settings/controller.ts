import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
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
} from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { modelList, settingsSummary, type FastSnapshot } from "../fast/controller.ts";
import { FastModeService } from "../fast/service.ts";
import { OpenAIUsageService } from "../usage/controller.ts";
import { settingItemsFromDescriptors, SettingsSubmenu, textPanel } from "./ui/panel.ts";

const OPENAI_SETTINGS_COMMAND = "openai-settings";

function guardHostUi<A>(callback: () => A, fallback: A): A {
  let result = fallback;
  safeHostUi(() => {
    result = callback();
  });
  return result;
}

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
  const scalar = Predicate.isString(value)
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
    hasTerminalUI,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport,
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

  /** Config read that degrades to undefined instead of throwing inside host UI callbacks. */
  const pickerConfig = (ctx: ExtensionContext): ResolvedConfig | undefined => {
    try {
      return config(ctx);
    } catch {
      return undefined;
    }
  };

  const applySetting = (ctx: ExtensionContext, id: string, value: string) => {
    updateContext(ctx);
    const update = Effect.gen(function* () {
      if (id === "fast.enabled") {
        yield* FastModeService.use((service) => service.setDesired(ctx, value === "true"));
        yield* Effect.sync(() => resetFastRoutingTransport(ctx));
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
    ).catch(() => undefined);
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
        // One guarded snapshot per picker session: closures below render inside host UI
        // callbacks where a thrown OpenAIBoundaryError (projection reset mid-session)
        // would escape into Pi's dispatcher.
        let cfg: ResolvedConfig;
        try {
          cfg = config(ctx);
        } catch {
          safeHostUi(() => ctx.ui.notify("Better OpenAI settings are unavailable.", "warning"));
          return undefined;
        }
        return ctx.ui
          .custom((tui, theme, keyboard, done) => {
            let outerList: SettingsList | undefined;
            const fastItems = (): SettingItem[] => [
              {
                id: "fast.enabled",
                label: "Fast mode",
                currentValue: String(MutableRef.get(fastProjection).desiredActive),
                values: ["true", "false"],
                description: `Request OpenAI fast mode. Activates for package-supported models: ${modelList()}.`,
              },
              ...settingItemsFromDescriptors(FAST_SETTING_DESCRIPTORS, cfg),
            ];
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
                  textPanel("Redacted config", formatDiagnosticValue(redactedConfig), complete),
              },
            ];
            const submenu = (
              title: string,
              items: () => SettingItem[],
              complete: (selectedValue?: string) => void,
              summary: () => string,
            ) =>
              new SettingsSubmenu({
                title,
                items,
                onChange: writeSetting,
                done: complete,
                summary,
              });
            const sections = (): SettingsSurfaceItem[] => [
              {
                kind: "group",
                id: "section.fast",
                label: "Fast mode",
                currentValue: settingsSummary(ctx, MutableRef.get(fastProjection)),
                description: "Configure OpenAI fast mode and persistence.",
                submenu: (_value, complete) =>
                  submenu("Fast mode settings", fastItems, complete, () =>
                    settingsSummary(ctx, MutableRef.get(fastProjection)),
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
                    () => settingItemsFromDescriptors(COMPACTION_SETTING_DESCRIPTORS, cfg),
                    complete,
                    () => compactionSummary(cfg),
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
                    () => settingItemsFromDescriptors(FOOTER_SETTING_DESCRIPTORS, cfg),
                    complete,
                    () => cfg.footer.mode,
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
                    () => settingItemsFromDescriptors(USAGE_SETTING_DESCRIPTORS, cfg),
                    complete,
                    () => usageSummary(cfg),
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
                    () => settingItemsFromDescriptors(IMAGE_SETTING_DESCRIPTORS, cfg),
                    complete,
                    () => imageSummary(cfg),
                  ),
              },
              {
                kind: "group",
                id: "section.diagnostics",
                label: "Diagnostics",
                currentValue: "debug / config",
                description: "Show diagnostics, config paths, and redacted raw config.",
                submenu: (_value, complete) =>
                  submenu("Diagnostics", diagnosticItems, complete, () => "debug / config"),
              },
            ];
            const reconcilePicker = () =>
              guardHostUi(() => {
                const nextConfig = pickerConfig(ctx);
                if (nextConfig) cfg = nextConfig;
                if (outerList)
                  for (const section of sections())
                    outerList.updateValue(section.id, section.currentValue);
                tui.requestRender();
              }, undefined);
            function writeSetting(id: string, value: string): Promise<void> {
              return applySetting(ctx, id, value).then(() => {
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
              header: new (class {
                render() {
                  return [
                    theme.fg("accent", theme.bold("Better OpenAI Settings")),
                    theme.fg("dim", cfg.configPath),
                    "",
                  ];
                }
                invalidate() {}
              })(),
              items: sections(),
              height: 8,
              listTheme: getSettingsListTheme(),
              onChange: reconcilePicker,
              onCancel: () => safeHostUi(() => done(undefined)),
              search: true,
              matchesKeybinding: Predicate.isFunction(keyboard?.matches)
                ? (data, id) => keyboard.matches(data, id)
                : undefined,
              requestRender: () => safeHostUi(() => tui.requestRender()),
              dim: (text) => theme.fg("dim", text),
              bridge: {
                invoke: guardHostUi,
                afterInput: () => safeHostUi(() => tui.requestRender()),
              },
            });
            outerList = created.list;
            return created.surface;
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
          let cfg: ResolvedConfig | undefined;
          try {
            cfg = config(ctx);
          } catch {
            // Help remains useful before the session runtime has published its config.
          }
          safeHostUi(() =>
            ctx.ui.notify(
              [
                "Better OpenAI settings",
                ...descriptors.map(
                  (descriptor) =>
                    `  ${descriptor.id}${cfg ? `=${descriptor.currentValue(cfg)}` : ""}  — ${descriptor.description}`,
                ),
                "",
                "Usage: /openai-settings <id> <value>",
                "       /openai-settings diagnostics",
              ].join("\n"),
              "info",
            ),
          );
          return Promise.resolve();
        }
        case "Diagnostics":
          safeHostUi(() => ctx.ui.notify(formatDebugStatus(ctx), "info"));
          return Promise.resolve();
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
          return Promise.resolve();
        case "Apply":
          return applySetting(ctx, dispatch.id, dispatch.value);
      }
    },
  });
}
