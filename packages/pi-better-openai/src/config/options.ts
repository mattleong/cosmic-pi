import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Str from "effect/String";
import { formatDuration } from "pi-cosmic-core/display";
import {
  decodeSettingUpdate,
  oneOfRule,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core/settings-completion";
import type { ResolvedConfig } from "./schema.ts";
import {
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
} from "./schema.ts";

const NonBlankStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => Str.trim(value).length > 0, {
    identifier: "NonBlankSettingString",
  }),
);

export const ON_OFF_VALUES = ["on", "off"] as const;
export const ON_OFF_RULE = "must be on or off";
const DURATION_RULE = "must be a duration such as 30s or 2m";
export const formatOnOff = (value: boolean): string => (value ? "on" : "off");

/** `on`/`off`, also accepting `true`/`false` and any letter case. */
export const OnOffSchema = Schema.String.check(
  Schema.isPattern(/^\s*(?:on|off|true|false)\s*$/iu),
).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (value) => /^\s*(?:on|true)\s*$/iu.test(value),
      encode: formatOnOff,
    }),
  ),
);

const DURATION_UNITS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 } as const;
const DURATION_PATTERN = /^\s*(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h)?\s*)+$/u;
const DURATION_PART = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/gu;

const durationMilliseconds = (value: string): number =>
  Arr.reduce(
    Array.from(Fn.pipe(value, Str.matchAll(DURATION_PART))),
    0,
    (total, [, amount = "0", unit]) => {
      const scale = unit === "s" || unit === "m" || unit === "h" ? DURATION_UNITS[unit] : 1;
      return total + Number(amount) * scale;
    },
  );

/** A duration such as `30s`, `1m 30s`, or a bare number of milliseconds. */
const DurationMillisecondsSchema = Schema.String.check(Schema.isPattern(DURATION_PATTERN)).pipe(
  Schema.decodeTo(
    Schema.Finite,
    SchemaTransformation.transform({
      decode: durationMilliseconds,
      encode: (value) => formatDuration(value),
    }),
  ),
);

// Each label names its setting on every surface: inside its settings group, and in help, status,
// and confirmations, where no group frames it.
export const FAST_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  {
    id: "persistState",
    label: "Remember fast mode",
    currentValue: (cfg) => formatOnOff(cfg.persistState),
    values: ON_OFF_VALUES,
    description: "Keep fast mode on or off in new sessions.",
    decoder: OnOffSchema,
    rule: ON_OFF_RULE,
  },
];
export const COMPACTION_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  {
    id: "compaction.enabled",
    label: "OpenAI compaction",
    currentValue: (cfg) => formatOnOff(cfg.compaction.enabled),
    values: ON_OFF_VALUES,
    description:
      "Use OpenAI native compaction when Pi triggers compaction for OpenAI Responses models.",
    decoder: OnOffSchema,
    rule: ON_OFF_RULE,
  },
];
export const USAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  {
    id: "usage.refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => formatDuration(cfg.usage.refreshIntervalMs),
    values: ["15s", "30s", "1m", "2m", "5m", "10m"],
    description: "How often usage refreshes.",
    decoder: DurationMillisecondsSchema,
    rule: DURATION_RULE,
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    label: "Usage on plans only",
    currentValue: (cfg) => formatOnOff(cfg.usage.showOnlyOnSubscriptionModels),
    values: ON_OFF_VALUES,
    description: "Show usage only when the current OpenAI model signs in with a subscription plan.",
    decoder: OnOffSchema,
    rule: ON_OFF_RULE,
  },
  {
    id: "usage.showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => formatOnOff(cfg.usage.showResetTimes),
    values: ON_OFF_VALUES,
    description: "Show when each usage window resets.",
    decoder: OnOffSchema,
    rule: ON_OFF_RULE,
  },
];
const IMAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  {
    id: "image.enabled",
    label: "Image tool",
    currentValue: (cfg) => formatOnOff(cfg.image.enabled),
    values: ON_OFF_VALUES,
    description: "Allow image requests from the openai_image tool and /openai image.",
    decoder: OnOffSchema,
    rule: ON_OFF_RULE,
  },
  {
    id: "image.defaultModel",
    label: "Image fallback model",
    currentValue: (cfg) => cfg.image.defaultModel,
    description: "Codex model that runs image requests when the current model isn't OpenAI Codex.",
    decoder: NonBlankStringSchema,
    rule: "must name a model",
  },
  {
    id: "image.defaultSave",
    label: "Save images to",
    currentValue: (cfg) => cfg.image.defaultSave,
    values: IMAGE_SAVE_MODES,
    description: "Where generated images are saved by default.",
    decoder: ImageSaveModeSchema,
    rule: oneOfRule(IMAGE_SAVE_MODES),
  },
  {
    id: "image.outputFormat",
    label: "Image format",
    currentValue: (cfg) => cfg.image.outputFormat,
    values: IMAGE_OUTPUT_FORMATS,
    description: "Generated image file format.",
    decoder: ImageOutputFormatSchema,
    rule: oneOfRule(IMAGE_OUTPUT_FORMATS),
  },
  {
    id: "image.timeoutMs",
    label: "Image timeout",
    currentValue: (cfg) => formatDuration(cfg.image.timeoutMs),
    values: ["30s", "1m", "2m", "3m", "5m"],
    description: "How long an image request may take.",
    decoder: DurationMillisecondsSchema,
    rule: DURATION_RULE,
  },
];
export const imageSettingDescriptors = (
  modelIds: readonly string[],
): readonly SettingsOptionDescriptor<ResolvedConfig>[] =>
  modelIds.length === 0
    ? IMAGE_SETTING_DESCRIPTORS
    : Arr.map(IMAGE_SETTING_DESCRIPTORS, (descriptor) =>
        descriptor.id === "image.defaultModel" ? { ...descriptor, values: modelIds } : descriptor,
      );
export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor<ResolvedConfig>[] = [
  ...FAST_SETTING_DESCRIPTORS,
  ...COMPACTION_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...IMAGE_SETTING_DESCRIPTORS,
];

export const prepareSettingUpdate = decodeSettingUpdate(SETTINGS_OPTION_DESCRIPTORS);
