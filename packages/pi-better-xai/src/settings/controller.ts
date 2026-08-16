import { isFunctionValue } from "pi-cosmic-core";
import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { completeSettingsArguments, dispatchSettingsCommand } from "pi-cosmic-core";
import { createSettingsListSurface } from "pi-cosmic-ui/manager/settings-surface";
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

  const applySetting = (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
    view?: {
      readonly applied: (currentValue: string) => void;
      readonly reverted: (currentValue: string) => void;
    },
  ): Promise<void> => {
    const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === id);
    /** Current persisted projection value; undefined when the projection is unavailable. */
    const persistedValue = (): string | undefined => {
      if (!descriptor) return undefined;
      try {
        return descriptor.currentValue(config(ctx));
      } catch {
        return undefined;
      }
    };
    // Snapshot before the write so an optimistic display can still be rolled back when the
    // projection becomes unavailable while the update is in flight.
    const before = view ? persistedValue() : undefined;
    const revertOptimisticDisplay = () => {
      const current = persistedValue() ?? before;
      if (view && current !== undefined) view.reverted(current);
    };
    return run(
      XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(
        Effect.tap(() =>
          recoverHostUi("settings_render", () => updateFooter(ctx)).pipe(
            Effect.andThen(
              recoverHostUi("settings_success", () => {
                const current = descriptor ? descriptor.currentValue(config(ctx)) : value;
                if (view) view.applied(current);
                else ctx.ui.notify(`${id} = ${current}`, "info");
              }),
            ),
          ),
        ),
        Effect.catch((error) =>
          recoverHostUi("settings_error", () => ctx.ui.notify(error.message, "error")).pipe(
            Effect.andThen(recoverHostUi("settings_revert", revertOptimisticDisplay)),
          ),
        ),
      ),
      signal,
    ).catch(() => {
      notifyAtHostBoundary(ctx, "Better xAI settings are unavailable.", "warning");
      try {
        revertOptimisticDisplay();
      } catch {
        // Hostile list/render callbacks stay contained at the host boundary.
      }
    });
  };

  const openInteractiveSettings = (ctx: ExtensionContext): Promise<void> => {
    const capturedSignal = captureSignal(ctx);
    if (capturedSignal._tag === "Unavailable")
      return completeHostFeedback(ctx, "Better xAI settings are unavailable.", "warning");
    let cfg: ResolvedConfig;
    try {
      cfg = config(ctx);
    } catch {
      return completeHostFeedback(ctx, "Better xAI settings are unavailable.", "warning");
    }
    const items: SettingItem[] = SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      currentValue: descriptor.currentValue(cfg),
      values: [...(descriptor.values ?? [])],
      description: descriptor.description,
    }));
    return ctx.ui
      .custom<undefined>(
        (tui, theme, keybindings, done) =>
          createSettingsListSurface({
            header: new Text(theme.fg("accent", theme.bold("Better xAI Settings")), 1, 1),
            items,
            height: Math.min(12, items.length + 2),
            listTheme: getSettingsListTheme(),
            // SettingsList displays the cycled value optimistically, so both apply outcomes route
            // through the same display update: success shows the committed value and failure
            // restores the persisted projection value.
            onChange: (id, value, list) => {
              const show = (currentValue: string) => {
                list.updateValue(id, currentValue);
                tui.requestRender();
              };
              void applySetting(ctx, id, value, capturedSignal.signal, {
                applied: show,
                reverted: show,
              });
            },
            onCancel: () => done(undefined),
            matchesKeybinding: isFunctionValue(keybindings?.matches)
              ? (data, id) => keybindings.matches(data, id)
              : undefined,
            requestRender: () => tui.requestRender(),
            dim: (text) => theme.fg("dim", text),
          }).surface,
      )
      .then(
        () => undefined,
        () => notifyAtHostBoundary(ctx, "Unable to open Better xAI settings.", "warning"),
      );
  };

  pi.registerCommand("xai-settings", {
    description: "Configure Better xAI usage display",
    getArgumentCompletions: (prefix) =>
      completeSettingsArguments(prefix, SETTINGS_OPTION_DESCRIPTORS, [
        { value: "help", label: "help", description: "Show setting ids and usage" },
        {
          value: "diagnostics",
          label: "diagnostics",
          description: "Show Better xAI diagnostics",
        },
      ]),
    handler: (args, ctx) => {
      const dispatch = dispatchSettingsCommand(args, SETTINGS_OPTION_DESCRIPTORS);
      const showHelp = () => {
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
      };
      switch (dispatch._tag) {
        case "OpenInteractive":
          return ctx.mode === "tui" && isFunctionValue(ctx.ui.custom)
            ? openInteractiveSettings(ctx)
            : showHelp();
        case "Help":
          return showHelp();
        case "Diagnostics":
          try {
            return completeHostFeedback(ctx, formatDebugStatus(ctx), "info");
          } catch {
            return completeHostFeedback(ctx, "Better xAI diagnostics are unavailable.", "warning");
          }
        case "Invalid":
          if (dispatch.reason === "missing-value")
            return completeHostFeedback(ctx, "Usage: /xai-settings <id> <value>", "error");
          if (dispatch.reason === "unknown-setting")
            return completeHostFeedback(ctx, `Unknown setting: ${dispatch.id}`, "error");
          return completeHostFeedback(
            ctx,
            `Invalid value for ${dispatch.id}. Expected one of: ${dispatch.allowedValues.join(", ")}`,
            "error",
          );
        case "Apply": {
          const capturedSignal = captureSignal(ctx);
          if (capturedSignal._tag === "Unavailable")
            return completeHostFeedback(ctx, "Better xAI settings are unavailable.", "warning");
          return applySetting(ctx, dispatch.id, dispatch.value, capturedSignal.signal);
        }
      }
    },
  });
}
