import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import type { ResolvedCosmicUiConfig } from "../config/schema.ts";
import { FOOTER_DENSITIES, MEDIA_PLACEMENTS } from "../config/schema.ts";
import { CosmicUiService } from "../host-service.ts";

const VISIBILITY_IDS = [
  "model",
  "effort",
  "location",
  "openai.fast",
  "branch",
  "pullRequest",
  "git",
  "context",
  "session",
  "metrics",
  "openai.usage",
  "xai.usage",
  "extensions",
] as const;

export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext(ctx: ExtensionContext): void;
    update(ctx: ExtensionContext): void;
    run<A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal): Promise<A>;
  },
): void {
  pi.registerCommand("cosmic-ui", {
    description: "Configure Cosmic UI elements",
    handler: (_args, ctx) => {
      options.updateContext(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify("Cosmic UI settings require interactive TUI mode.", "warning");
        return Promise.resolve();
      }
      const cfg = options.config();
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Footer enabled",
          currentValue: String(cfg.footer.enabled),
          values: ["true", "false"],
        },
        {
          id: "density",
          label: "Footer density",
          currentValue: cfg.footer.density,
          values: [...FOOTER_DENSITIES],
        },
        {
          id: "mediaPlacement",
          label: "Media placement",
          currentValue: cfg.footer.mediaPlacement,
          values: [...MEDIA_PLACEMENTS],
        },
        ...VISIBILITY_IDS.map((id) => ({
          id: `visible:${id}`,
          label: `Show ${id}`,
          currentValue: String(!cfg.footer.hidden.includes(id)),
          values: ["true", "false"],
        })),
      ];
      return ctx.ui.custom((tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new Text(theme.fg("accent", theme.bold("Cosmic UI")), 1, 1));
        const list = new SettingsList(
          items,
          Math.min(14, items.length + 2),
          getSettingsListTheme(),
          (id, value) => {
            let patch: Partial<ResolvedCosmicUiConfig["footer"]>;
            if (id === "enabled") patch = { enabled: value === "true" };
            else if (id === "density")
              patch = { density: value as ResolvedCosmicUiConfig["footer"]["density"] };
            else if (id === "mediaPlacement")
              patch = {
                mediaPlacement: value as ResolvedCosmicUiConfig["footer"]["mediaPlacement"],
              };
            else patch = {};
            const update = id.startsWith("visible:")
              ? CosmicUiService.use((service) =>
                  service.setFooterVisibility(id.slice("visible:".length), value === "true"),
                )
              : CosmicUiService.use((service) => service.updateFooterConfig(patch));
            void options
              .run(update, ctx.signal)
              .then(() => {
                list.updateValue(id, value);
                options.update(ctx);
                tui.requestRender();
              })
              .catch(() => ctx.ui.notify("Unable to update Cosmic UI configuration.", "error"));
          },
          () => done(undefined),
          { enableSearch: true },
        );
        container.addChild(list);
        return {
          render: (width) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data) => list.handleInput?.(data),
        };
      });
    },
  });
}
