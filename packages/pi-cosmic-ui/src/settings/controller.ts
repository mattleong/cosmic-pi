import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  DEFAULT_FOOTER_ORDER,
  FOOTER_DENSITIES,
  FooterDensitySchema,
  type ResolvedCosmicUiConfig,
} from "../config/schema.ts";
import type { FooterPatch } from "../config/store.ts";
import { settingsSubcommand, withInvocationAuthority } from "../boundary/host-settings-command.ts";
import { CosmicUiService } from "../protocol/service.ts";
import { settingsItemsFromDescriptors } from "../manager/settings-surface.ts";
import { decodeUnknownOrUndefined, registerExtensionCommand } from "pi-cosmic-core";

const BooleanSettingSchema = Schema.Literals(["true", "false"]);
const UsageSettingSchema = Schema.Literals(["automatic", "hidden"]);
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
      readonly patch: FooterPatch;
    }
  | { readonly _tag: "SetVisibility"; readonly id: string; readonly visible: boolean };

/** Each row decodes its own third-party SettingsList value into a closed, valid update. */
const settingDescriptors = [
  {
    id: "enabled",
    label: "Custom footer",
    description:
      "Disable to use Pi's default footer. Item visibility still applies to provider status.",
    values: BooleanSettingSchema.literals,
    currentValue: (config: ResolvedCosmicUiConfig) => String(config.footer.enabled),
    change: (value: string): CosmicUiSettingChange | undefined => {
      const enabled = decodeUnknownOrUndefined(BooleanSettingSchema, value);
      return enabled && { _tag: "UpdateFooter", patch: { enabled: enabled === "true" } };
    },
  },
  {
    id: "density",
    label: "Footer density",
    description: "How much the footer shows.",
    values: FOOTER_DENSITIES,
    currentValue: (config: ResolvedCosmicUiConfig) => config.footer.density,
    change: (value: string): CosmicUiSettingChange | undefined => {
      const density = decodeUnknownOrUndefined(FooterDensitySchema, value);
      return density && { _tag: "UpdateFooter", patch: { density } };
    },
  },
  ...DEFAULT_FOOTER_ORDER.map((item) => {
    // Usage rows say automatic/hidden for the same visibility preference.
    const usage = item === "openai.usage" || item === "xai.usage";
    const schema = usage ? UsageSettingSchema : BooleanSettingSchema;
    const [shown, hidden] = schema.literals;
    return {
      id: `visible:${item}`,
      label: footerLabels[item],
      description: usage
        ? "Automatic on eligible models. Hidden stops automatic requests; the usage command still works."
        : "Show this item in the footer.",
      values: schema.literals,
      currentValue: (config: ResolvedCosmicUiConfig) =>
        config.footer.hidden.includes(item) ? hidden : shown,
      change: (value: string): CosmicUiSettingChange | undefined => {
        const decoded = decodeUnknownOrUndefined(schema, value);
        return decoded && { _tag: "SetVisibility", id: item, visible: decoded === shown };
      },
    };
  }),
];

/** `/cosmic-ui`, whose `settings` use the shared settings shell and picker. */
export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext(ctx: ExtensionContext): void;
    update(ctx: ExtensionContext): void;
    run<A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal): Promise<A>;
    captureAuthority?: () => () => boolean;
  },
): void {
  const settings = withInvocationAuthority(options.captureAuthority, (isCurrent) =>
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
      onInvoke: options.updateContext,
      apply: (_ctx, id, value, signal) => {
        const change = settingDescriptors.find((descriptor) => descriptor.id === id)?.change(value);
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
      afterApply: options.update,
      open: (_ctx, session) =>
        session.picker(settingsItemsFromDescriptors(settingDescriptors, options.config()), 14),
    }),
  );
  registerExtensionCommand(pi, {
    name: "cosmic-ui",
    description: "Cosmic UI footer settings",
    subcommands: [settings],
  });
}
