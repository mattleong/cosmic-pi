import type { ResolvedConfig } from "./schema.ts";
import {
  FOOTER_MODES,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  PET_PLACEMENTS,
  PET_STATES,
} from "./schema.ts";
import { isRecord } from "../utils.ts";

export type SettingsOptionSection = "root" | "usage" | "footer" | "image" | "pets";

export type SettingsValueContext = {
  petEmptyValue?: string;
};

export type SettingsOptionDescriptor = {
  id: string;
  section: SettingsOptionSection;
  key: string;
  label: string;
  description: string;
  values?: readonly string[];
  parse(rawValue: string, context?: SettingsValueContext): boolean | number | string;
  currentValue(cfg: ResolvedConfig): string;
};

const booleanSetting = (rawValue: string): boolean => rawValue === "true";
const numberSetting = (rawValue: string): number => Number(rawValue);
const stringSetting = (rawValue: string): string => rawValue;

export const FAST_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "persistState",
    section: "root",
    key: "persistState",
    label: "Persist fast state",
    currentValue: (cfg) => String(cfg.persistState),
    values: ["true", "false"],
    description: "Remember fast-mode state across sessions.",
    parse: booleanSetting,
  },
];

export const FOOTER_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "footer.mode",
    section: "footer",
    key: "mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer, status = pi footer plus status line, off = no Better OpenAI footer/status unless Footer pet is enabled.",
    parse: stringSetting,
  },
];

export const USAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    section: "usage",
    key: "enabled",
    label: "Usage display",
    currentValue: (cfg) => String(cfg.usage.enabled),
    values: ["true", "false"],
    description: "Fetch and display OpenAI subscription usage windows.",
    parse: booleanSetting,
  },
  {
    id: "usage.refreshIntervalMs",
    section: "usage",
    key: "refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => String(cfg.usage.refreshIntervalMs),
    values: ["15000", "30000", "60000", "120000", "300000", "600000"],
    description: "Usage refresh interval in milliseconds.",
    parse: numberSetting,
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    section: "usage",
    key: "showOnlyOnSubscriptionModels",
    label: "Usage only on OAuth",
    currentValue: (cfg) => String(cfg.usage.showOnlyOnSubscriptionModels),
    values: ["true", "false"],
    description: "Only show usage when the current OpenAI model uses subscription/OAuth auth.",
    parse: booleanSetting,
  },
  {
    id: "usage.showResetTimes",
    section: "usage",
    key: "showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => String(cfg.usage.showResetTimes),
    values: ["true", "false"],
    description: "Include compact reset countdowns and local reset times.",
    parse: booleanSetting,
  },
];

export const IMAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "image.enabled",
    section: "image",
    key: "enabled",
    label: "Image tool",
    currentValue: (cfg) => String(cfg.image.enabled),
    values: ["true", "false"],
    description: "Allow the openai_image tool to make image requests.",
    parse: booleanSetting,
  },
  {
    id: "image.defaultModel",
    section: "image",
    key: "defaultModel",
    label: "Image model",
    currentValue: (cfg) => cfg.image.defaultModel,
    values: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5"],
    description: "Mainline model used for image generation when current model is not openai-codex.",
    parse: stringSetting,
  },
  {
    id: "image.defaultSave",
    section: "image",
    key: "defaultSave",
    label: "Image save",
    currentValue: (cfg) => cfg.image.defaultSave,
    values: IMAGE_SAVE_MODES,
    description: "Where generated images are saved by default.",
    parse: stringSetting,
  },
  {
    id: "image.outputFormat",
    section: "image",
    key: "outputFormat",
    label: "Image format",
    currentValue: (cfg) => cfg.image.outputFormat,
    values: IMAGE_OUTPUT_FORMATS,
    description: "Generated image file format.",
    parse: stringSetting,
  },
  {
    id: "image.timeoutMs",
    section: "image",
    key: "timeoutMs",
    label: "Image timeout",
    currentValue: (cfg) => String(cfg.image.timeoutMs),
    values: ["30000", "60000", "120000", "180000", "300000"],
    description: "Image request timeout in milliseconds.",
    parse: numberSetting,
  },
];

export const PET_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "pets.enabled",
    section: "pets",
    key: "enabled",
    label: "Enabled",
    currentValue: (cfg) => String(cfg.pets.enabled),
    values: ["true", "false"],
    description:
      "Render a custom Codex pet from ${CODEX_HOME:-~/.codex}/pets in the Better OpenAI footer.",
    parse: booleanSetting,
  },
  {
    id: "pets.slug",
    section: "pets",
    key: "slug",
    label: "Pet",
    currentValue: (cfg) => cfg.pets.slug,
    description: "Selected custom pet slug.",
    parse: (rawValue, context) =>
      rawValue === (context?.petEmptyValue ?? "not selected") ? "" : rawValue,
  },
  {
    id: "pets.placement",
    section: "pets",
    key: "placement",
    label: "Placement",
    currentValue: (cfg) => cfg.pets.placement,
    values: PET_PLACEMENTS,
    description: "Footer layout: stacked, inline-left, inline-right, badge, or habitat divider.",
    parse: stringSetting,
  },
  {
    id: "pets.state",
    section: "pets",
    key: "state",
    label: "Idle state",
    currentValue: (cfg) => cfg.pets.state,
    values: PET_STATES,
    description: "Animation row to show when pi is idle.",
    parse: stringSetting,
  },
  {
    id: "pets.thinkingState",
    section: "pets",
    key: "thinkingState",
    label: "Thinking state",
    currentValue: (cfg) => cfg.pets.thinkingState,
    values: PET_STATES,
    description: "Animation row to show while the model is thinking or streaming.",
    parse: stringSetting,
  },
  {
    id: "pets.toolState",
    section: "pets",
    key: "toolState",
    label: "Tool state",
    currentValue: (cfg) => cfg.pets.toolState,
    values: PET_STATES,
    description: "Animation row to show during tool execution.",
    parse: stringSetting,
  },
  {
    id: "pets.failedToolState",
    section: "pets",
    key: "failedToolState",
    label: "Failed tool state",
    currentValue: (cfg) => cfg.pets.failedToolState,
    values: PET_STATES,
    description: "Animation row to flash after any tool call returns an error.",
    parse: stringSetting,
  },
  {
    id: "pets.idleEmotes",
    section: "pets",
    key: "idleEmotes",
    label: "Random idle emotes",
    currentValue: (cfg) => String(cfg.pets.idleEmotes),
    values: ["true", "false"],
    description: "Occasionally flash a wave or jump while pi is idle.",
    parse: booleanSetting,
  },
  {
    id: "pets.idleEmoteIntervalMs",
    section: "pets",
    key: "idleEmoteIntervalMs",
    label: "Idle emote interval",
    currentValue: (cfg) => String(cfg.pets.idleEmoteIntervalMs),
    values: ["5000", "15000", "30000", "60000", "120000", "300000"],
    description: "Average delay between random idle pet emotes in milliseconds.",
    parse: numberSetting,
  },
  {
    id: "pets.sizeCells",
    section: "pets",
    key: "sizeCells",
    label: "Size",
    currentValue: (cfg) => String(cfg.pets.sizeCells),
    values: ["4", "6", "8", "10", "12", "16"],
    description: "Pet image width in terminal cells.",
    parse: numberSetting,
  },
];

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  ...FAST_SETTING_DESCRIPTORS,
  ...FOOTER_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...IMAGE_SETTING_DESCRIPTORS,
  ...PET_SETTING_DESCRIPTORS,
];

const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export type SettingPatchContext = SettingsValueContext & {
  persistState?: boolean;
  active?: boolean;
  desiredActive?: boolean;
};

export function applySettingToRawConfig(
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
  context: SettingPatchContext = {},
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const bool = rawValue === "true";
  if (id === "fast.enabled") {
    if (context.persistState) {
      next.active = context.active ?? bool;
      next.desiredActive = context.desiredActive ?? bool;
    }
  } else {
    const descriptor = SETTINGS_OPTION_BY_ID.get(id);
    if (!descriptor) return next;
    const parsedValue = descriptor.parse(rawValue, context);
    if (descriptor.section === "root") next[descriptor.key] = parsedValue;
    else {
      const currentSection = next[descriptor.section];
      const section = isRecord(currentSection) ? { ...currentSection } : {};
      section[descriptor.key] = parsedValue;
      next[descriptor.section] = section;
    }
  }
  return next;
}
