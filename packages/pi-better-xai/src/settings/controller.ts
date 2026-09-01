import * as Predicate from "effect/Predicate";

import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import {
  completeSettingsArguments,
  dispatchSettingsCommand,
  invokeHostCallback,
  notifyAtHostBoundary,
  type HostNotificationLevel,
  type CapturedHostSignal,
} from "pi-cosmic-core";
import { createSettingsListSurface } from "pi-cosmic-ui/manager/settings-surface";
import { hasSettingsSurface, openSettingsSurfaceAtHostBoundary } from "../boundary/host-ui.ts";
import { SETTINGS_OPTION_DESCRIPTORS } from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { XaiUsageService } from "../usage/controller.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    captureSignal(ctx: ExtensionContext): CapturedHostSignal;
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
    updateDisplay?: (currentValue: string) => void,
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
    const before = updateDisplay ? persistedValue() : undefined;
    const revertOptimisticDisplay = () => {
      const current = persistedValue() ?? before;
      if (updateDisplay && current !== undefined)
        invokeHostCallback(() => updateDisplay(current), undefined);
    };
    const update = XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(
      Effect.result,
    );
    return run(update, signal).then(
      (settlement) => {
        if (settlement._tag === "Failure") {
          notifyAtHostBoundary(ctx, settlement.failure.message, "error");
          revertOptimisticDisplay();
          return;
        }
        invokeHostCallback(() => updateFooter(ctx), undefined);
        const current = persistedValue() ?? value;
        if (updateDisplay) invokeHostCallback(() => updateDisplay(current), undefined);
        else notifyAtHostBoundary(ctx, `${id} = ${current}`, "info");
      },
      () => {
        notifyAtHostBoundary(ctx, "Better xAI settings are unavailable.", "warning");
        revertOptimisticDisplay();
      },
    );
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
    const pickerGenerations = new Map<string, number>();
    return openSettingsSurfaceAtHostBoundary(
      ctx,
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
            const generation = (pickerGenerations.get(id) ?? 0) + 1;
            pickerGenerations.set(id, generation);
            const show = (currentValue: string) => {
              if (pickerGenerations.get(id) !== generation) return;
              invokeHostCallback(() => {
                list.updateValue(id, currentValue);
                tui.requestRender();
              }, undefined);
            };
            void applySetting(ctx, id, value, capturedSignal.signal, show);
          },
          onCancel: () => invokeHostCallback(() => done(undefined), undefined),
          matchesKeybinding: invokeHostCallback(
            () => Predicate.isFunction(keybindings?.matches),
            false,
          )
            ? (data, id) => invokeHostCallback(() => keybindings.matches(data, id), false)
            : undefined,
          requestRender: () => invokeHostCallback(() => tui.requestRender(), undefined),
          dim: (text) => invokeHostCallback(() => theme.fg("dim", text), text),
          // The shared bridge guards render, invalidate, and input delegation through this
          // package-owned host boundary.
          bridge: { invoke: invokeHostCallback },
        }).surface,
    ).then((outcome) => {
      if (outcome === "failed")
        notifyAtHostBoundary(ctx, "Unable to open Better xAI settings.", "warning");
    });
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
          return hasSettingsSurface(ctx) ? openInteractiveSettings(ctx) : showHelp();
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
