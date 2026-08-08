import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { fullScreenSettingsHint, VimSettingsAdapter } from "pi-cosmic-ui/manager/keybindings";
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
    onApplied?: (currentValue: string) => void,
  ): Promise<void> =>
    run(
      XaiUsageService.use((service) => service.updateSetting(id, value)).pipe(
        Effect.tap(() =>
          recoverHostUi("settings_render", () => updateFooter(ctx)).pipe(
            Effect.andThen(
              recoverHostUi("settings_success", () => {
                const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === id);
                const current = descriptor ? descriptor.currentValue(config(ctx)) : value;
                if (onApplied) onApplied(current);
                else ctx.ui.notify(`${id} = ${current}`, "info");
              }),
            ),
          ),
        ),
        Effect.catch((error) =>
          recoverHostUi("settings_error", () => ctx.ui.notify(error.message, "error")),
        ),
      ),
      signal,
    ).catch(() => notifyAtHostBoundary(ctx, "Better xAI settings are unavailable.", "warning"));

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
      .custom<undefined>((tui, theme, keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Better xAI Settings")), 1, 1));
        const list = new SettingsList(
          items,
          Math.min(12, items.length + 2),
          getSettingsListTheme(),
          (id, value) => {
            void applySetting(ctx, id, value, capturedSignal.signal, (currentValue) => {
              list.updateValue(id, currentValue);
              tui.requestRender();
            });
          },
          () => done(undefined),
          { enableSearch: true },
        );
        const vimList = new VimSettingsAdapter(list, {
          search: true,
          matchesKeybinding:
            typeof keybindings?.matches === "function"
              ? (data, id) => keybindings.matches(data, id)
              : undefined,
          requestRender: () => tui.requestRender(),
          renderHint: (mode, helpExpanded) =>
            theme.fg(
              "dim",
              ` ${fullScreenSettingsHint({
                searching: mode === "search",
                search: true,
                helpExpanded,
              })} `,
            ),
        });
        container.addChild(vimList);
        return {
          get focused(): boolean {
            return vimList.focused;
          },
          set focused(value: boolean) {
            vimList.focused = value;
          },
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => vimList.handleInput(data),
        };
      })
      .then(
        () => undefined,
        () => notifyAtHostBoundary(ctx, "Unable to open Better xAI settings.", "warning"),
      );
  };

  pi.registerCommand("xai-settings", {
    description: "Configure Better xAI usage display",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.replace(/^\s+/, "");
      const [head = "", ...rest] = normalized.split(/\s+/);
      if (rest.length === 0 && !/\s$/.test(normalized)) {
        const query = head.toLowerCase();
        const choices = [
          ...SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => ({
            value: descriptor.id,
            label: descriptor.id,
            description: descriptor.description,
          })),
          { value: "help", label: "help", description: "Show setting ids and usage" },
          {
            value: "diagnostics",
            label: "diagnostics",
            description: "Show Better xAI diagnostics",
          },
        ];
        const matches = choices.filter((choice) => choice.value.toLowerCase().startsWith(query));
        return matches.length > 0 ? matches : null;
      }
      const descriptor = SETTINGS_OPTION_DESCRIPTORS.find((entry) => entry.id === head);
      if (!descriptor) return null;
      const valuePrefix = (rest[0] ?? "").toLowerCase();
      const matches = (descriptor.values ?? [])
        .filter((value) => value.toLowerCase().startsWith(valuePrefix))
        .map((value) => ({
          value: `${head} ${value}`,
          label: `${head} ${value}`,
          description: descriptor.description,
        }));
      return matches.length > 0 ? matches : null;
    },
    handler: (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed && ctx.mode === "tui" && typeof ctx.ui.custom === "function")
        return openInteractiveSettings(ctx);
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

      return applySetting(ctx, id, value, capturedSignal.signal);
    },
  });
}
