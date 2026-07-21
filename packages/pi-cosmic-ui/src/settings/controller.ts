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

const BooleanSettingSchema = Schema.Literals(["true", "false"]);
const VisibilityIdSchema = Schema.Literals(VISIBILITY_IDS);

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
  pi.registerCommand("cosmic-ui", {
    description: "Configure Cosmic UI elements",
    handler: (_args, ctx) => {
      options.updateContext(ctx);
      if (options.callbacks.invoke("host-query", () => ctx.mode, "rpc") !== "tui") {
        options.callbacks.invoke(
          "notify",
          () => ctx.ui.notify("Cosmic UI settings require interactive TUI mode.", "warning"),
          undefined,
        );
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
        ...VISIBILITY_IDS.map((id) => ({
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
      const invoked = options.callbacks.invoke(
        "host-query",
        () => {
          opened = ctx.ui.custom((tui, theme, _keybindings, done) =>
            options.callbacks.invoke(
              "host-query",
              () => {
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
                        : CosmicUiService.use((service) =>
                            service.updateFooterConfig(change.patch),
                          );
                    const pending = options.callbacks.invoke<Promise<unknown> | undefined>(
                      "host-query",
                      () => options.run(update, signal),
                      undefined,
                    );
                    if (!pending) {
                      options.callbacks.invoke(
                        "notify",
                        () => ctx.ui.notify("Unable to update Cosmic UI configuration.", "error"),
                        undefined,
                      );
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
                  () => options.callbacks.invoke("host-query", () => done(undefined), undefined),
                  { enableSearch: true },
                );
                container.addChild(list);
                return {
                  render: (width: number) =>
                    options.callbacks.invoke("host-query", () => container.render(width), []),
                  invalidate: () =>
                    options.callbacks.invoke("host-query", () => container.invalidate(), undefined),
                  handleInput: (data: string) =>
                    options.callbacks.invoke(
                      "host-query",
                      () => list.handleInput?.(data),
                      undefined,
                    ),
                };
              },
              inertComponent(),
            ),
          );
          return true;
        },
        false,
      );
      if (!invoked) {
        abort?.release();
        options.callbacks.invoke(
          "notify",
          () => ctx.ui.notify("Unable to open Cosmic UI settings.", "error"),
          undefined,
        );
        return Promise.resolve();
      }
      return Promise.resolve(opened)
        .then(
          () => undefined,
          () => {
            options.callbacks.invoke(
              "notify",
              () => ctx.ui.notify("Unable to open Cosmic UI settings.", "error"),
              undefined,
            );
          },
        )
        .finally(() => abort?.release());
    },
  });
}
