import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DEFAULT_FOOTER_ORDER,
  FOOTER_DENSITIES,
  FooterDensitySchema,
  MEDIA_PLACEMENTS,
  MediaPlacementSchema,
  type ResolvedCosmicUiConfig,
} from "../config/schema.ts";
import {
  snapshotHostAbortSignal,
  type HostCallbackBoundaryShape,
} from "../boundary/host-callback.ts";
import { CosmicUiService } from "../host/service.ts";

const BooleanSettingSchema = Schema.Literals(["true", "false"]);
const VisibilityIdSchema = Schema.Literals(DEFAULT_FOOTER_ORDER);

export type CosmicUiSettingChange =
  | {
      readonly _tag: "UpdateFooter";
      readonly patch: Partial<ResolvedCosmicUiConfig["footer"]>;
    }
  | { readonly _tag: "SetVisibility"; readonly id: string; readonly visible: boolean };

/** Decodes the third-party SettingsList callback into a closed set of valid updates. */
export function decodeCosmicUiSettingChange(
  id: unknown,
  value: unknown,
): CosmicUiSettingChange | undefined {
  if (typeof id !== "string") return undefined;
  const booleanValue = Option.getOrUndefined(
    Schema.decodeUnknownOption(BooleanSettingSchema)(value),
  );
  if (id === "enabled")
    return booleanValue === undefined
      ? undefined
      : { _tag: "UpdateFooter", patch: { enabled: booleanValue === "true" } };
  if (id === "density") {
    const density = Option.getOrUndefined(Schema.decodeUnknownOption(FooterDensitySchema)(value));
    return density === undefined ? undefined : { _tag: "UpdateFooter", patch: { density } };
  }
  if (id === "mediaPlacement") {
    const mediaPlacement = Option.getOrUndefined(
      Schema.decodeUnknownOption(MediaPlacementSchema)(value),
    );
    return mediaPlacement === undefined
      ? undefined
      : { _tag: "UpdateFooter", patch: { mediaPlacement } };
  }
  if (!id.startsWith("visible:") || booleanValue === undefined) return undefined;
  const visibilityId = Option.getOrUndefined(
    Schema.decodeUnknownOption(VisibilityIdSchema)(id.slice("visible:".length)),
  );
  return visibilityId === undefined
    ? undefined
    : { _tag: "SetVisibility", id: visibilityId, visible: booleanValue === "true" };
}

/** Converts an update rejection into a contained host notification and a resolved recovery. */
export function recoverSettingsUpdate(
  update: Promise<unknown>,
  callbacks: HostCallbackBoundaryShape,
  notify: () => void,
): Promise<void> {
  return update.then(
    () => undefined,
    () => {
      callbacks.invoke("notify", notify, undefined);
    },
  );
}

export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext(ctx: ExtensionContext): void;
    update(ctx: ExtensionContext): void;
    run<A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal): Promise<A>;
    callbacks: HostCallbackBoundaryShape;
  },
): void {
  const hostQuery = <A>(callback: () => A, fallback: A) =>
    options.callbacks.invoke("host-query", callback, fallback);
  pi.registerCommand("cosmic-ui", {
    description: "Configure Cosmic UI elements",
    handler: (_args, ctx) => {
      options.updateContext(ctx);
      const notify = (message: string, level: "warning" | "error") =>
        options.callbacks.invoke("notify", () => ctx.ui.notify(message, level), undefined);
      if (hostQuery(() => ctx.mode, "rpc") !== "tui") {
        notify("Cosmic UI settings require interactive TUI mode.", "warning");
        return Promise.resolve();
      }
      const abort = snapshotHostAbortSignal(options.callbacks, () => ctx.signal);
      const signal = abort?.signal;
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
        ...DEFAULT_FOOTER_ORDER.map((id) => ({
          id: `visible:${id}`,
          label: `Show ${id}`,
          currentValue: String(!cfg.footer.hidden.includes(id)),
          values: ["true", "false"],
        })),
      ];
      const inertComponent = () => ({
        render: () => [] as string[],
        invalidate: () => undefined,
        handleInput: () => undefined,
      });
      let opened: Promise<unknown> | undefined;
      const invoked = hostQuery(() => {
        opened = ctx.ui.custom((tui, theme, _keybindings, done) =>
          hostQuery(() => {
            const container = new Container();
            container.addChild(new Text(theme.fg("accent", theme.bold("Cosmic UI")), 1, 1));
            const list = new SettingsList(
              items,
              Math.min(14, items.length + 2),
              getSettingsListTheme(),
              (id, value) => {
                const change = decodeCosmicUiSettingChange(id, value);
                if (!change) return;
                const update =
                  change._tag === "SetVisibility"
                    ? CosmicUiService.use((service) =>
                        service.setFooterVisibility(change.id, change.visible),
                      )
                    : CosmicUiService.use((service) => service.updateFooterConfig(change.patch));
                const pending = hostQuery<Promise<unknown> | undefined>(
                  () => options.run(update, signal),
                  undefined,
                );
                if (!pending) {
                  notify("Unable to update Cosmic UI configuration.", "error");
                  return;
                }
                void recoverSettingsUpdate(
                  pending.then(() => {
                    options.callbacks.invoke(
                      "request-render",
                      () => {
                        list.updateValue(id, value);
                        options.update(ctx);
                        tui.requestRender();
                      },
                      undefined,
                    );
                  }),
                  options.callbacks,
                  () => ctx.ui.notify("Unable to update Cosmic UI configuration.", "error"),
                );
              },
              () => hostQuery(() => done(undefined), undefined),
              { enableSearch: true },
            );
            container.addChild(list);
            return {
              render: (width: number) => hostQuery(() => container.render(width), []),
              invalidate: () => hostQuery(() => container.invalidate(), undefined),
              handleInput: (data: string) => hostQuery(() => list.handleInput?.(data), undefined),
            };
          }, inertComponent()),
        );
        return true;
      }, false);
      if (!invoked) {
        abort?.release();
        notify("Unable to open Cosmic UI settings.", "error");
        return Promise.resolve();
      }
      return Promise.resolve(opened)
        .then(
          () => undefined,
          () => {
            notify("Unable to open Cosmic UI settings.", "error");
          },
        )
        .finally(() => abort?.release());
    },
  });
}
