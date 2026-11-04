import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
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
import {
  AUTO_SETTING_VALUE,
  ON_OFF_SETTING_VALUES,
  settingOnOff,
  settingsItemsFromDescriptors,
} from "../manager/settings-surface.ts";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";

const BooleanSettingSchema = Schema.Literals(ON_OFF_SETTING_VALUES);
const UsageSettingSchema = Schema.Literals([AUTO_SETTING_VALUE, "off"]);
const footerLabels = {
  model: "Model",
  effort: "Thinking level",
  location: "Directory",
  "openai.fast": "Fast indicator",
  branch: "Branch",
  pullRequest: "Pull request",
  subagents: "Subagent profiles and delegation",
  git: "Git changes",
  context: "Context usage",
  session: "Session",
  metrics: "Token and cost metrics",
  "openai.usage": "OpenAI usage",
  extensions: "Extension status",
} satisfies Record<(typeof DEFAULT_FOOTER_ORDER)[number], string>;

type CosmicUiSettingChange = Data.TaggedEnum<{
  UpdateFooter: { readonly patch: FooterPatch };
  SetVisibility: { readonly id: string; readonly visible: boolean };
}>;
const CosmicUiSettingChange = Data.taggedEnum<CosmicUiSettingChange>();

const settingDescriptors = [
  {
    id: "enabled",
    label: "Custom footer",
    description:
      "Disable to use Pi's default footer. Item visibility still applies to provider status.",
    values: BooleanSettingSchema.literals,
    currentValue: (config: ResolvedCosmicUiConfig) => settingOnOff(config.footer.enabled),
    change: (value: string): CosmicUiSettingChange | undefined => {
      const enabled = decodeUnknownOrUndefined(BooleanSettingSchema)(value);
      return (
        enabled && CosmicUiSettingChange.UpdateFooter({ patch: { enabled: enabled === "on" } })
      );
    },
  },
  {
    id: "density",
    label: "Footer density",
    description: "How much the footer shows.",
    values: FOOTER_DENSITIES,
    currentValue: (config: ResolvedCosmicUiConfig) => config.footer.density,
    change: (value: string): CosmicUiSettingChange | undefined => {
      const density = decodeUnknownOrUndefined(FooterDensitySchema)(value);
      return density && CosmicUiSettingChange.UpdateFooter({ patch: { density } });
    },
  },
  ...Arr.map(DEFAULT_FOOTER_ORDER, (item) => {
    const usage = item === "openai.usage";
    const schema = usage ? UsageSettingSchema : BooleanSettingSchema;
    const [shown, hidden] = schema.literals;
    return {
      id: `visible:${item}`,
      label: footerLabels[item],
      description: usage
        ? "auto shows usage on eligible models. off hides it and stops automatic requests; the usage command still works."
        : "Show this item in the footer.",
      values: schema.literals,
      currentValue: (config: ResolvedCosmicUiConfig) =>
        config.footer.hidden.includes(item) ? hidden : shown,
      change: (value: string): CosmicUiSettingChange | undefined => {
        const decoded = decodeUnknownOrUndefined(schema)(value);
        return (
          decoded && CosmicUiSettingChange.SetVisibility({ id: item, visible: decoded === shown })
        );
      },
    };
  }),
];

/** The `/cosmic-ui settings` rows for a configuration, as the picker shows them. */
export const cosmicUiSettingsItems = (config: ResolvedCosmicUiConfig) =>
  settingsItemsFromDescriptors(settingDescriptors, config);

export function registerSettingsCommand(
  pi: ExtensionAPI,
  options: {
    config(): ResolvedCosmicUiConfig;
    updateContext: (ctx: ExtensionContext) => void;
    update: (ctx: ExtensionContext) => void;
    run<E>(effect: Effect.Effect<void, E, CosmicUiService>, signal?: AbortSignal): Promise<void>;
    captureAuthority: () => () => boolean;
  },
): void {
  const settings = withInvocationAuthority(options.captureAuthority, (isCurrent, owner) =>
    settingsSubcommand<ResolvedCosmicUiConfig>({
      owner,
      root: "cosmic-ui",
      description: "Footer settings",
      title: "Cosmic UI",
      isCurrent,
      descriptors: settingDescriptors,
      examples: ["density compact", "visible:git off"],
      config: () => options.config(),
      status: () => {
        const config = options.config();
        return Arr.join(
          [
            "Cosmic UI settings",
            ...Arr.map(
              settingDescriptors,
              (descriptor) => `  ${descriptor.id} = ${descriptor.currentValue(config)}`,
            ),
          ],
          "\n",
        );
      },
      onInvoke: options.updateContext,
      apply: (_ctx, id, value, signal) => {
        const change = Option.getOrUndefined(
          Arr.findFirst(settingDescriptors, (descriptor) => descriptor.id === id),
        )?.change(value);
        if (!change) return Promise.resolve(Result.fail({ message: `Unknown setting: ${id}` }));
        const update = CosmicUiService.use((service) =>
          CosmicUiSettingChange.$match(change, {
            SetVisibility: ({ id: item, visible }) => service.setFooterVisibility(item, visible),
            UpdateFooter: ({ patch }) => service.updateFooterConfig(patch),
          }),
        );
        return options.run(update, signal).then(
          () => Result.succeed(undefined),
          () => Result.fail({ message: "Couldn't save Cosmic UI settings" }),
        );
      },
      afterApply: options.update,
      open: (_ctx, session) =>
        session.picker(cosmicUiSettingsItems(options.config()), settingDescriptors.length),
    }),
  );
  registerExtensionCommand(pi, {
    name: "cosmic-ui",
    description: "Cosmic UI footer settings",
    subcommands: [settings],
  });
}
