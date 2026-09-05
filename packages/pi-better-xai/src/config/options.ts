import {
  decodeSettingUpdate as makeDecodeSettingUpdate,
  makeUsageSettingDescriptors,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./schema.ts";

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] =
  makeUsageSettingDescriptors<ResolvedConfig>(
    "Only show usage when the current xAI model uses subscription/OAuth auth.",
  );

export const decodeSettingUpdate = makeDecodeSettingUpdate(SETTINGS_OPTION_DESCRIPTORS);
