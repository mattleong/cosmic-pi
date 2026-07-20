import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SETTINGS_OPTION_DESCRIPTORS, type ResolvedConfig } from "../config.ts";
import { XaiUsageService } from "../usage-controller.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  const { config, updateFooter, formatDebugStatus, run } = options;
  const done = (signal?: AbortSignal) => run(Effect.void, signal);

  pi.registerCommand("xai-settings", {
    description: "Configure Better xAI usage display",
    handler: (args, ctx) => {
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
        return done(ctx.signal);
      }

      if (trimmed === "diagnostics" || trimmed === "debug") {
        ctx.ui.notify(formatDebugStatus(ctx), "info");
        return done(ctx.signal);
      }

      const [id, ...valueParts] = trimmed.split(/\s+/);
      const value = valueParts.join(" ").trim();
      if (!id || !value) {
        ctx.ui.notify("Usage: /xai-settings <id> <value>", "error");
        return done(ctx.signal);
      }
      const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === id);
      if (!descriptor) {
        ctx.ui.notify(`Unknown setting: ${id}`, "error");
        return done(ctx.signal);
      }
      if (descriptor.values && !(descriptor.values as readonly string[]).includes(value)) {
        ctx.ui.notify(
          `Invalid value for ${id}. Expected one of: ${descriptor.values.join(", ")}`,
          "error",
        );
        return done(ctx.signal);
      }

      return run(
        XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              updateFooter(ctx);
              ctx.ui.notify(`${id} = ${descriptor.currentValue(config(ctx))}`, "info");
            }),
          ),
          Effect.catch((error) => Effect.sync(() => ctx.ui.notify(error.message, "error"))),
        ),
        ctx.signal,
      );
    },
  });
}
