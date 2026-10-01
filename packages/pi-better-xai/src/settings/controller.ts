import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";

import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { invokeHostCallback, type ExtensionCommand } from "pi-cosmic-core";
import { settingsSubcommand } from "pi-cosmic-ui/boundary/host-settings-command";
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

/** Adds `/xai settings` through the shared settings shell; the picker stays here. */
export function registerSettingsController(
  command: ExtensionCommand,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig | undefined;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    captureAuthority?: () => () => boolean;
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  const createCommand = (isCurrent: () => boolean) =>
    settingsSubcommand({
      root: "xai",
      description:
        "Configure xAI usage refresh details; footer visibility is in /cosmic-ui settings",
      title: "Better xAI",
      isCurrent,
      descriptors: SETTINGS_OPTION_DESCRIPTORS,
      examples: ["usage.refreshIntervalMs 30000", "usage.showResetTimes true"],
      config: (ctx) => (isCurrent() ? options.config(ctx) : undefined),
      status: options.formatDebugStatus,
      apply: (_ctx, id, value, signal) => {
        const stale = () => Result.fail({ message: "", stale: true });
        if (!isCurrent()) return Promise.resolve(stale());
        return options
          .run(
            XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(Effect.result),
            signal,
          )
          .then(
            (result) => (isCurrent() ? result : stale()),
            (error) => {
              if (!isCurrent()) return stale();
              throw error;
            },
          );
      },
      afterApply: (ctx) => {
        if (isCurrent()) options.updateFooter(ctx);
      },
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
                  if (!isCurrent() || !pickerGenerations.isCurrent(id, generation)) return false;
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
  const registered = createCommand(() => true);
  command.add({
    ...registered,
    handler: (args, ctx) => {
      const isCurrent = options.captureAuthority?.() ?? (() => true);
      return createCommand(isCurrent).handler(args, ctx);
    },
  });
}
