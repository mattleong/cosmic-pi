import * as Predicate from "effect/Predicate";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  DEFAULT_FOOTER_ORDER,
  FOOTER_DENSITIES,
  FooterDensitySchema,
  type ResolvedCosmicUiConfig,
} from "../config/schema.ts";
import {
  snapshotHostAbortSignal,
  type HostCallbackBoundaryContract,
} from "../boundary/host-callback.ts";
import { CosmicUiService } from "../protocol/service.ts";
import {
  managerSettingsTheme,
  createSettingsListSurface,
  settingsRowGenerations,
} from "../manager/settings-surface.ts";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";

const BooleanSettingSchema = Schema.Literals(["true", "false"]);
const VisibilityIdSchema = Schema.Literals(DEFAULT_FOOTER_ORDER);
const isUsageSetting = (id: string) => id === "visible:openai.usage" || id === "visible:xai.usage";
const visibilityValue = (id: string, visible: boolean) =>
  isUsageSetting(id) ? (visible ? "automatic" : "hidden") : String(visible);
const footerLabels = {
  model: "Model",
  effort: "Thinking level",
  location: "Directory",
  "openai.fast": "Fast indicator",
  branch: "Branch",
  pullRequest: "Pull request",
  git: "Git changes",
  context: "Context usage",
  session: "Session",
  metrics: "Token and cost metrics",
  "openai.usage": "OpenAI usage",
  "xai.usage": "xAI usage",
  extensions: "Extension status",
} satisfies Record<(typeof DEFAULT_FOOTER_ORDER)[number], string>;

type CosmicUiSettingChange =
  | {
      readonly _tag: "UpdateFooter";
      readonly patch: Partial<ResolvedCosmicUiConfig["footer"]>;
    }
  | { readonly _tag: "SetVisibility"; readonly id: string; readonly visible: boolean };

/** Decodes the third-party SettingsList callback into a closed set of valid updates. */
function decodeCosmicUiSettingChange<IdInput, ValueInput>(
  id: IdInput,
  value: ValueInput,
): CosmicUiSettingChange | undefined {
  if (!Predicate.isString(id)) return undefined;
  const booleanValue = decodeUnknownOrUndefined(
    BooleanSettingSchema,
    isUsageSetting(id)
      ? value === "automatic"
        ? "true"
        : value === "hidden"
          ? "false"
          : undefined
      : value,
  );
  if (id === "enabled")
    return booleanValue === undefined
      ? undefined
      : { _tag: "UpdateFooter", patch: { enabled: booleanValue === "true" } };
  if (id === "density") {
    const density = decodeUnknownOrUndefined(FooterDensitySchema, value);
    return density === undefined ? undefined : { _tag: "UpdateFooter", patch: { density } };
  }
  if (!id.startsWith("visible:") || booleanValue === undefined) return undefined;
  const visibilityId = decodeUnknownOrUndefined(VisibilityIdSchema, id.slice("visible:".length));
  return visibilityId === undefined
    ? undefined
    : { _tag: "SetVisibility", id: visibilityId, visible: booleanValue === "true" };
}

const projectedSettingValue = (config: ResolvedCosmicUiConfig, id: string): string | undefined => {
  if (id === "enabled") return String(config.footer.enabled);
  if (id === "density") return config.footer.density;
  if (!id.startsWith("visible:")) return undefined;
  const visibilityId = decodeUnknownOrUndefined(VisibilityIdSchema, id.slice("visible:".length));
  return visibilityId === undefined
    ? undefined
    : visibilityValue(id, !config.footer.hidden.includes(visibilityId));
};

export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext(ctx: ExtensionContext): void;
    update(ctx: ExtensionContext): void;
    run<A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal): Promise<A>;
    callbacks: HostCallbackBoundaryContract;
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
        notify("Open Pi in an interactive terminal to change Cosmic UI settings.", "warning");
        return Promise.resolve();
      }
      const abort = snapshotHostAbortSignal(options.callbacks, () => ctx.signal);
      const signal = abort?.signal;
      const cfg = options.config();
      const generations = settingsRowGenerations();
      const items: SettingItem[] = [
        {
          id: "enabled",
          label: "Custom footer",
          description:
            "Disable to use Pi's default footer. Item visibility still applies to provider status.",
          currentValue: String(cfg.footer.enabled),
          values: ["true", "false"],
        },
        {
          id: "density",
          label: "Footer density",
          currentValue: cfg.footer.density,
          values: [...FOOTER_DENSITIES],
        },
        ...DEFAULT_FOOTER_ORDER.map((id) => ({
          id: `visible:${id}`,
          label: footerLabels[id],
          currentValue: visibilityValue(`visible:${id}`, !cfg.footer.hidden.includes(id)),
          values: isUsageSetting(`visible:${id}`) ? ["automatic", "hidden"] : ["true", "false"],
          description: isUsageSetting(`visible:${id}`)
            ? "Automatic on eligible models. Hidden stops automatic requests; the usage command still works."
            : "Show this item in the footer.",
        })),
      ];
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const inertComponent = () => ({
        focused: false,
        render: () => [] as string[],
        invalidate: () => undefined,
        handleInput: () => undefined,
      });
      let opened: Promise<unknown> | undefined;
      const invoked = hostQuery(() => {
        opened = ctx.ui.custom((tui, theme, keybindings, done) =>
          hostQuery(
            () =>
              createSettingsListSurface({
                header: new Text(theme.fg("accent", theme.bold("Cosmic UI")), 1, 1),
                items,
                height: Math.min(14, items.length + 2),
                listTheme: managerSettingsTheme(theme),
                onChange: (id, value, list) => {
                  const change = decodeCosmicUiSettingChange(id, value);
                  if (!change) return;
                  const generation = generations.begin(id);
                  const settle = (failed: boolean) => {
                    if (!generations.isCurrent(id, generation)) return;
                    const authoritative = hostQuery<string | undefined>(
                      () => projectedSettingValue(options.config(), id),
                      undefined,
                    );
                    if (authoritative !== undefined && generations.isCurrent(id, generation))
                      options.callbacks.invoke(
                        "request-render",
                        () => {
                          if (!generations.isCurrent(id, generation)) return;
                          list.updateValue(id, authoritative);
                          options.update(ctx);
                          tui.requestRender();
                        },
                        undefined,
                      );
                    if (failed && generations.isCurrent(id, generation))
                      notify("Unable to update Cosmic UI configuration.", "error");
                  };
                  const update = CosmicUiService.use((service) =>
                    change._tag === "SetVisibility"
                      ? service.setFooterVisibility(change.id, change.visible)
                      : service.updateFooterConfig(change.patch),
                  );
                  const pending = hostQuery<Promise<unknown> | undefined>(
                    () => options.run(update, signal),
                    undefined,
                  );
                  if (!pending) {
                    settle(true);
                    return;
                  }
                  void Promise.resolve(pending).then(
                    () => settle(false),
                    () => settle(true),
                  );
                },
                onCancel: () => hostQuery(() => done(undefined), undefined),
                matchesKeybinding: Predicate.isFunction(keybindings?.matches)
                  ? (data, id) => hostQuery(() => keybindings.matches(data, id), false)
                  : undefined,
                requestRender: () => hostQuery(() => tui.requestRender(), undefined),
                dim: (text) => hostQuery(() => theme.fg("dim", text), text),
                // hostQuery keeps its fallbacks: hostile render/input callbacks stay contained
                // behind this package's host-callback boundary.
                bridge: { invoke: (callback, fallback) => hostQuery(callback, fallback) },
              }).surface,
            inertComponent(),
          ),
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
