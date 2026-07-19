import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SETTINGS_OPTION_DESCRIPTORS,
  applySettingToRawConfig,
  readRawConfig,
  writeConfig,
  type ResolvedConfig,
} from "../config.ts";
import type { UsageController } from "../usage-controller.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    refresh(ctx: ExtensionContext): ResolvedConfig;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    usageController: UsageController;
  },
): void {
  const { config, refresh, updateFooter, formatDebugStatus, usageController } = options;

  pi.registerCommand("xai-settings", {
    description: "Configure Better xAI usage display",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "help") {
        const cfg = config(ctx);
        const lines = [
          "Better xAI settings",
          ...SETTINGS_OPTION_DESCRIPTORS.map(
            (descriptor) =>
              `  ${descriptor.id}=${descriptor.currentValue(cfg)}  — ${descriptor.description}`,
          ),
          "",
          "Usage:",
          "  /xai-settings",
          "  /xai-settings <id> <value>",
          "  /xai-settings diagnostics",
          "",
          "Examples:",
          "  /xai-settings usage.enabled false",
          "  /xai-settings usage.showResetTimes true",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (trimmed === "diagnostics" || trimmed === "debug") {
        ctx.ui.notify(formatDebugStatus(ctx), "info");
        return;
      }

      const [id, ...valueParts] = trimmed.split(/\s+/);
      const value = valueParts.join(" ").trim();
      if (!id || !value) {
        ctx.ui.notify("Usage: /xai-settings <id> <value>", "error");
        return;
      }
      const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === id);
      if (!descriptor) {
        ctx.ui.notify(`Unknown setting: ${id}`, "error");
        return;
      }
      if (descriptor.values && !(descriptor.values as readonly string[]).includes(value)) {
        ctx.ui.notify(
          `Invalid value for ${id}. Expected one of: ${descriptor.values.join(", ")}`,
          "error",
        );
        return;
      }

      const current = config(ctx);
      const nextRaw = applySettingToRawConfig(readRawConfig(current.configPath), id, value);
      writeConfig(current.configPath, nextRaw);
      const next = refresh(ctx);
      usageController.restartAfterSettingsChange(ctx, next);
      updateFooter(ctx);
      ctx.ui.notify(`${id} = ${descriptor.currentValue(next)}`, "info");
    },
  });
}
