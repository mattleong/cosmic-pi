import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { SETTINGS_OPTION_DESCRIPTORS, type ResolvedConfig } from "../config/index.ts";
import { XaiBoundaryError, XaiUsageService } from "../usage/index.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    notifyAtHostBoundary(
      ctx: ExtensionContext,
      message: string,
      level: "info" | "warning" | "error",
    ): void;
    captureSignal(
      ctx: ExtensionContext,
    ):
      | { readonly _tag: "Captured"; readonly signal: AbortSignal | undefined }
      | { readonly _tag: "Unavailable" };
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  const { config, updateFooter, formatDebugStatus, notifyAtHostBoundary, captureSignal, run } =
    options;
  const completeHostFeedback = (
    ctx: ExtensionContext,
    message: string,
    level: "info" | "warning" | "error",
  ) => {
    notifyAtHostBoundary(ctx, message, level);
    return Promise.resolve();
  };
  const recoverUi = (operation: string, action: () => void) =>
    Effect.try({
      try: action,
      catch: () =>
        new XaiBoundaryError({
          operation,
          message: "Unable to update Better xAI settings UI.",
        }),
    }).pipe(Effect.catch(() => Effect.logWarning(`Better xAI UI recovery: ${operation}_failed.`)));

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
            recoverUi("settings_render", () => updateFooter(ctx)).pipe(
              Effect.andThen(
                recoverUi("settings_success", () =>
                  ctx.ui.notify(`${id} = ${descriptor.currentValue(config(ctx))}`, "info"),
                ),
              ),
            ),
          ),
          Effect.catch((error) =>
            recoverUi("settings_error", () => ctx.ui.notify(error.message, "error")),
          ),
        ),
        capturedSignal.signal,
      ).catch(() => notifyAtHostBoundary(ctx, "Better xAI settings are unavailable.", "warning"));
    },
  });
}
