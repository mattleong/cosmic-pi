import * as Predicate from "effect/Predicate";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core";
import { registerSettingsCommand } from "pi-cosmic-ui/boundary/host-settings-command";
import { openOwnedSurfacePromise } from "pi-cosmic-ui/boundary/host-surface";
import {
  managerSettingsTheme,
  createSettingsListSurface,
  settingsItemsFromDescriptors,
  settingsRowGenerations,
} from "pi-cosmic-ui/manager/settings-surface";
import { SETTINGS_OPTION_DESCRIPTORS } from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { XaiUsageService } from "../usage/controller.ts";

export function registerSettingsController(
  pi: ExtensionAPI,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig | undefined;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  registerSettingsCommand(pi, {
    command: "xai-settings",
    description: "Configure xAI usage refresh details; footer visibility is in /cosmic-ui",
    title: "Better xAI",
    descriptors: SETTINGS_OPTION_DESCRIPTORS,
    examples: ["usage.refreshIntervalMs 30000", "usage.showResetTimes true"],
    config: options.config,
    status: options.formatDebugStatus,
    apply: (_ctx, id, value, signal) =>
      options.run(
        XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(Effect.result),
        signal,
      ),
    afterApply: options.updateFooter,
    open: (ctx, session) => {
      const cfg = session.config();
      if (!cfg) return Promise.resolve({ _tag: "Blocked" });
      const items = settingsItemsFromDescriptors(SETTINGS_OPTION_DESCRIPTORS, cfg);
      const pickerGenerations = settingsRowGenerations();
      return openOwnedSurfacePromise<undefined>(ctx, {
        placement: "inline",
        closedValue: undefined,
        create: ({ tui, theme, keybindings, finish }) =>
          createSettingsListSurface({
            header: new Text(theme.fg("accent", theme.bold("Better xAI settings")), 1, 1),
            items,
            height: Math.min(12, items.length + 2),
            listTheme: managerSettingsTheme(theme),
            // SettingsList displays the cycled value optimistically, so both apply outcomes route
            // through the same display update: success shows the committed value and failure
            // restores the persisted projection value.
            onChange: (id, value, list) => {
              const generation = pickerGenerations.begin(id);
              void session.apply(id, value, (currentValue) => {
                if (!pickerGenerations.isCurrent(id, generation)) return false;
                list.updateValue(id, currentValue);
                tui.requestRender();
                return true;
              });
            },
            onCancel: () => finish(undefined),
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
      });
    },
  });
}
