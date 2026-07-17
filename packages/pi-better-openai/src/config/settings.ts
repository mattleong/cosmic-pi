import { isRecord } from "../utils.ts";
import type { ResolvedConfig } from "./schema.ts";
import { FOOTER_MODES, IMAGE_OUTPUT_FORMATS, IMAGE_SAVE_MODES } from "./schema.ts";

export type SettingsOptionSection = "root" | "usage" | "footer" | "image";

export type SettingsOptionDescriptor = {
  id: string;
  section: SettingsOptionSection;
  key: string;
  label: string;
  description: string;
  values?: readonly string[];
  parse(rawValue: string): boolean | number | string;
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
      "replace = custom footer, status = pi footer plus status line, off = no Better OpenAI footer/status.",
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

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  ...FAST_SETTING_DESCRIPTORS,
  ...FOOTER_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...IMAGE_SETTING_DESCRIPTORS,
];

const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export type SettingPatchContext = {
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
    const parsedValue = descriptor.parse(rawValue);
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
