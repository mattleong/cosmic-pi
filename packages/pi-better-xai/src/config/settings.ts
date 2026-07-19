import { isRecord } from "../utils.ts";
import type { ResolvedConfig } from "./schema.ts";
import { FOOTER_MODES } from "./schema.ts";

export type SettingsOptionSection = "usage" | "footer";

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

export const FOOTER_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "footer.mode",
    section: "footer",
    key: "mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer line, status = pi status line, off = no Better xAI footer/status.",
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
    description: "Fetch and display xAI subscription usage windows.",
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
    description: "Only show usage when the current xAI model uses subscription/OAuth auth.",
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

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  ...USAGE_SETTING_DESCRIPTORS,
  ...FOOTER_SETTING_DESCRIPTORS,
];

const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export function applySettingToRawConfig(
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const descriptor = SETTINGS_OPTION_BY_ID.get(id);
  if (!descriptor) return next;
  const parsedValue = descriptor.parse(rawValue);
  const currentSection = next[descriptor.section];
  const section = isRecord(currentSection) ? { ...currentSection } : {};
  section[descriptor.key] = parsedValue;
  next[descriptor.section] = section;
  return next;
}
