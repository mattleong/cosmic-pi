import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type ExtensionCommand } from "pi-cosmic-core";
import {
  settingsSubcommand,
  withInvocationAuthority,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { settingsItemsFromDescriptors } from "pi-cosmic-ui/manager/settings-surface";
import { SETTINGS_OPTION_DESCRIPTORS } from "../config/options.ts";
import type { ResolvedConfig } from "../config/schema.ts";
import { XaiUsageService } from "../usage/controller.ts";

/** Adds `/xai settings` through the shared settings shell and picker. */
export function registerSettingsController(
  command: ExtensionCommand,
  options: {
    config(ctx: ExtensionContext): ResolvedConfig | undefined;
    updateFooter(ctx: ExtensionContext): void;
    formatDebugStatus(ctx: ExtensionContext): string;
    /**
     * Captures the invoking session's authority. The shared shell checks it before every apply,
     * picker display, notification, and footer update, so a retired settlement stays silent.
     */
    captureAuthority: () => () => boolean;
    run<A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  command.add(
    withInvocationAuthority(options.captureAuthority, (isCurrent) =>
      settingsSubcommand({
        root: "xai",
        description:
          "Configure xAI usage refresh details; footer visibility is in /cosmic-ui settings",
        title: "Better xAI",
        isCurrent,
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
        open: (_ctx, session) => {
          const cfg = session.config();
          return cfg
            ? session.picker(settingsItemsFromDescriptors(SETTINGS_OPTION_DESCRIPTORS, cfg))
            : Promise.resolve({ _tag: "Blocked" });
        },
      }),
    ),
  );
}
