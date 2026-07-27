import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { notifyAtHostBoundary, type HostNotificationLevel } from "../boundary/host-notifier.ts";
import { recoverHostUi } from "../boundary/host-ui.ts";
import { SETTINGS_OPTION_DESCRIPTORS, type ResolvedConfig } from "../config/index.ts";
import { XaiUsageService } from "../usage/index.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    captureSignal(
      ctx: ExtensionContext,
    ):
      | { readonly _tag: "Captured"; readonly signal: AbortSignal | undefined }
      | { readonly _tag: "Unavailable" };
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  const { config, updateFooter, formatDebugStatus, captureSignal, run } = options;
  const completeHostFeedback = (
    ctx: ExtensionContext,
    message: string,
    level: HostNotificationLevel,
  ) => {
    notifyAtHostBoundary(ctx, message, level);
    return Promise.resolve();
  };

  pi.registerCommand("xai-settings", {
    description: "Configure Better xAI usage display",
    handler: (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed || trimmed === "help") {
        let cfg: ResolvedConfig | undefined;
        try {
          cfg = config(ctx);
        } catch {
          // Help remains useful before the session runtime has published its config.
        }
        const lines = [
          "Better xAI settings",
          ...SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => {
            const current = cfg ? `=${descriptor.currentValue(cfg)}` : "";
            return `  ${descriptor.id}${current}  — ${descriptor.description}`;
          }),
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
        return completeHostFeedback(ctx, lines.join("\n"), "info");
      }

      if (trimmed === "diagnostics" || trimmed === "debug") {
        try {
          return completeHostFeedback(ctx, formatDebugStatus(ctx), "info");
        } catch {
          return completeHostFeedback(ctx, "Better xAI diagnostics are unavailable.", "warning");
        }
      }

      const [id, ...valueParts] = trimmed.split(/\s+/);
      const value = valueParts.join(" ").trim();
      if (!id || !value) {
        return completeHostFeedback(ctx, "Usage: /xai-settings <id> <value>", "error");
      }
      const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === id);
      if (!descriptor) {
        return completeHostFeedback(ctx, `Unknown setting: ${id}`, "error");
      }
      const allowedValues = descriptor.values;
      if (allowedValues && !(allowedValues as readonly string[]).includes(value)) {
        return completeHostFeedback(
          ctx,
          `Invalid value for ${id}. Expected one of: ${allowedValues.join(", ")}`,
          "error",
        );
      }

      const capturedSignal = captureSignal(ctx);
      if (capturedSignal._tag === "Unavailable")
        return completeHostFeedback(ctx, "Better xAI settings are unavailable.", "warning");

      return run(
        XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(
          Effect.tap(() =>
            recoverHostUi("settings_render", () => updateFooter(ctx)).pipe(
              Effect.andThen(
                recoverHostUi("settings_success", () =>
                  ctx.ui.notify(`${id} = ${descriptor.currentValue(config(ctx))}`, "info"),
                ),
              ),
            ),
          ),
          Effect.catch((error) =>
            recoverHostUi("settings_error", () => ctx.ui.notify(error.message, "error")),
          ),
        ),
        capturedSignal.signal,
      ).catch(() => notifyAtHostBoundary(ctx, "Better xAI settings are unavailable.", "warning"));
    },
  });
}
