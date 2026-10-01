import * as Predicate from "effect/Predicate";

import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type SettingItem } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  DEFAULT_FOOTER_ORDER,
  FOOTER_DENSITIES,
  FooterDensitySchema,
  type ResolvedCosmicUiConfig,
} from "../config/schema.ts";
import { type HostCallbackBoundaryContract } from "../boundary/host-callback.ts";
import { settingsSubcommand } from "../boundary/host-settings-command.ts";
import { openOwnedSurfacePromise } from "../boundary/host-surface.ts";
import { CosmicUiService } from "../protocol/service.ts";
import {
  managerSettingsTheme,
  createSettingsListSurface,
  settingsRowGenerations,
} from "../manager/settings-surface.ts";
import { decodeUnknownOrUndefined, registerExtensionCommand } from "pi-cosmic-core";

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

const settingDescriptors = [
  {
    id: "enabled",
    label: "Custom footer",
    description:
      "Disable to use Pi's default footer. Item visibility still applies to provider status.",
    values: ["true", "false"],
    currentValue: (config: ResolvedCosmicUiConfig) => String(config.footer.enabled),
  },
  {
    id: "density",
    label: "Footer density",
    description: "How much the footer shows.",
    values: [...FOOTER_DENSITIES],
    currentValue: (config: ResolvedCosmicUiConfig) => config.footer.density,
  },
  ...DEFAULT_FOOTER_ORDER.map((item) => {
    const id = `visible:${item}`;
    return {
      id,
      label: footerLabels[item],
      description: isUsageSetting(id)
        ? "Automatic on eligible models. Hidden stops automatic requests; the usage command still works."
        : "Show this item in the footer.",
      values: isUsageSetting(id) ? ["automatic", "hidden"] : ["true", "false"],
      currentValue: (config: ResolvedCosmicUiConfig) =>
        visibilityValue(id, !config.footer.hidden.includes(item)),
    };
  }),
];

/** `/cosmic-ui`, whose `settings` use the shared settings shell; the picker stays here. */
export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext(ctx: ExtensionContext): void;
    update(ctx: ExtensionContext): void;
    run<A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal): Promise<A>;
    callbacks: HostCallbackBoundaryContract;
    captureAuthority?: () => () => boolean;
  },
): void {
  const hostQuery = <A>(callback: () => A, fallback: A) =>
    options.callbacks.invoke("host-query", callback, fallback);
  const createSettings = (isCurrent: () => boolean) =>
    settingsSubcommand<ResolvedCosmicUiConfig>({
      root: "cosmic-ui",
      description: "Configure the Cosmic UI footer",
      title: "Cosmic UI",
      isCurrent,
      descriptors: settingDescriptors,
      examples: ["density compact", "visible:git false"],
      config: () => options.config(),
      status: () => {
        const config = options.config();
        return [
          "Cosmic UI settings",
          ...settingDescriptors.map(
            (descriptor) => `  ${descriptor.id} = ${descriptor.currentValue(config)}`,
          ),
        ].join("\n");
      },
      onInvoke: (ctx) => {
        if (isCurrent()) options.updateContext(ctx);
      },
      apply: (_ctx, id, value, signal) => {
        const change = decodeCosmicUiSettingChange(id, value);
        if (!change) return Promise.resolve(Result.fail({ message: `Unknown setting: ${id}` }));
        const update = CosmicUiService.use((service) =>
          change._tag === "SetVisibility"
            ? service.setFooterVisibility(change.id, change.visible)
            : service.updateFooterConfig(change.patch),
        );
        // Any failed write, including an unavailable runtime, rolls the row back with one error.
        return options.run(update, signal).then(
          () => Result.succeed(undefined),
          () => Result.fail({ message: "Couldn't save Cosmic UI settings" }),
        );
      },
      afterApply: (ctx) => {
        if (isCurrent()) options.update(ctx);
      },
      open: (ctx, session) => {
        const generations = settingsRowGenerations();
        const config = options.config();
        const items: SettingItem[] = settingDescriptors.map((descriptor) => ({
          id: descriptor.id,
          label: descriptor.label,
          description: descriptor.description,
          currentValue: descriptor.currentValue(config),
          values: [...descriptor.values],
        }));
        return openOwnedSurfacePromise<undefined>(ctx, {
          placement: "inline",
          closedValue: undefined,
          create: ({ tui, theme, keybindings, finish }) =>
            createSettingsListSurface({
              header: new Text(theme.fg("accent", theme.bold("Cosmic UI settings")), 1, 1),
              items,
              height: Math.min(14, items.length + 2),
              listTheme: managerSettingsTheme(theme),
              // The list shows the chosen value at once; each apply shows the committed or
              // restored value, and an older apply never overwrites a newer choice.
              onChange: (id, value, list) => {
                if (!decodeCosmicUiSettingChange(id, value)) return;
                const generation = generations.begin(id);
                void session.apply(id, value, (current) => {
                  if (!isCurrent() || !generations.isCurrent(id, generation)) return false;
                  hostQuery(() => {
                    list.updateValue(id, current);
                    tui.requestRender();
                  }, undefined);
                  return true;
                });
              },
              onCancel: () => finish(undefined),
              matchesKeybinding: Predicate.isFunction(keybindings?.matches)
                ? (data, id) => hostQuery(() => keybindings.matches(data, id), false)
                : undefined,
              requestRender: () => hostQuery(() => tui.requestRender(), undefined),
              dim: (text) => hostQuery(() => theme.fg("dim", text), text),
              // hostQuery keeps its fallbacks: hostile render/input callbacks stay contained
              // behind this package's host-callback boundary.
              bridge: { invoke: (callback, fallback) => hostQuery(callback, fallback) },
            }).surface,
        });
      },
    });
  const registered = createSettings(() => true);
  const settings = {
    ...registered,
    handler: (...args: Parameters<typeof registered.handler>) =>
      createSettings(options.captureAuthority?.() ?? (() => true)).handler(...args),
  };
  registerExtensionCommand(pi, {
    name: "cosmic-ui",
    description: "Cosmic UI footer settings",
    subcommands: [settings],
  });
}
