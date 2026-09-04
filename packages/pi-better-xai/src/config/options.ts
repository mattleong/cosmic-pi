import {
  BooleanFromJsonSchema,
  decodeSettingUpdate as makeDecodeSettingUpdate,
  FiniteNumberFromJsonSchema,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./schema.ts";

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  {
    id: "usage.refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => String(cfg.usage.refreshIntervalMs),
    values: ["15000", "30000", "60000", "120000", "300000", "600000"],
    description: "Usage refresh interval in milliseconds.",
    decoder: FiniteNumberFromJsonSchema,
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    label: "Usage only on OAuth",
    currentValue: (cfg) => String(cfg.usage.showOnlyOnSubscriptionModels),
    values: ["true", "false"],
    description: "Only show usage when the current xAI model uses subscription/OAuth auth.",
    decoder: BooleanFromJsonSchema,
  },
  {
    id: "usage.showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => String(cfg.usage.showResetTimes),
    values: ["true", "false"],
    description: "Include compact reset countdowns and local reset times.",
    decoder: BooleanFromJsonSchema,
  },
];

export const decodeSettingUpdate = makeDecodeSettingUpdate(SETTINGS_OPTION_DESCRIPTORS);
