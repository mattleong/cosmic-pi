import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sectionSettingValue, type JsonObject } from "pi-cosmic-core";
import type { ResolvedConfig } from "./schema.ts";
import {
  FOOTER_MODES,
  FooterModeSchema,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
} from "./schema.ts";

export class InvalidSettingError extends Schema.TaggedError<InvalidSettingError>()(
  "InvalidSettingError",
  { id: Schema.String, message: Schema.String },
) {}
export type SettingsOptionDescriptor = {
  id: string;
  label: string;
  description: string;
  values?: readonly string[];
  decoder: Schema.Decoder<boolean | number | string>;
  currentValue(cfg: ResolvedConfig): string;
};

const BooleanFromJsonSchema = Schema.fromJsonString(Schema.Boolean);
const FiniteNumberFromJsonSchema = Schema.fromJsonString(Schema.Number.check(Schema.isFinite()));
const NonBlankStringSchema = Schema.String.check(
  Schema.makeFilter((value: string) => value.trim().length > 0, {
    identifier: "NonBlankSettingString",
  }),
);

export const FAST_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "persistState",
    label: "Persist fast state",
    currentValue: (cfg) => String(cfg.persistState),
    values: ["true", "false"],
    description: "Remember fast-mode state across sessions.",
    decoder: BooleanFromJsonSchema,
  },
];
export const COMPACTION_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "compaction.enabled",
    label: "OpenAI compaction",
    currentValue: (cfg) => String(cfg.compaction.enabled),
    values: ["true", "false"],
    description:
      "Use OpenAI native compaction when Pi triggers compaction for OpenAI Responses models.",
    decoder: BooleanFromJsonSchema,
  },
];
export const FOOTER_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "footer.mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer, status = pi footer plus status line, off = no Better OpenAI footer/status.",
    decoder: FooterModeSchema,
  },
];
export const USAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    label: "Usage display",
    currentValue: (cfg) => String(cfg.usage.enabled),
    values: ["true", "false"],
    description: "Fetch and display OpenAI subscription usage windows.",
    decoder: BooleanFromJsonSchema,
  },
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
    description: "Only show usage when the current OpenAI model uses subscription/OAuth auth.",
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
export const IMAGE_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "image.enabled",
    label: "Image tool",
    currentValue: (cfg) => String(cfg.image.enabled),
    values: ["true", "false"],
    description: "Allow the openai_image tool to make image requests.",
    decoder: BooleanFromJsonSchema,
  },
  {
    id: "image.defaultModel",
    label: "Image model",
    currentValue: (cfg) => cfg.image.defaultModel,
    values: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5"],
    description: "Mainline model used for image generation when current model is not openai-codex.",
    decoder: NonBlankStringSchema,
  },
  {
    id: "image.defaultSave",
    label: "Image save",
    currentValue: (cfg) => cfg.image.defaultSave,
    values: IMAGE_SAVE_MODES,
    description: "Where generated images are saved by default.",
    decoder: ImageSaveModeSchema,
  },
  {
    id: "image.outputFormat",
    label: "Image format",
    currentValue: (cfg) => cfg.image.outputFormat,
    values: IMAGE_OUTPUT_FORMATS,
    description: "Generated image file format.",
    decoder: ImageOutputFormatSchema,
  },
  {
    id: "image.timeoutMs",
    label: "Image timeout",
    currentValue: (cfg) => String(cfg.image.timeoutMs),
    values: ["30000", "60000", "120000", "180000", "300000"],
    description: "Image request timeout in milliseconds.",
    decoder: FiniteNumberFromJsonSchema,
  },
];
export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  ...FAST_SETTING_DESCRIPTORS,
  ...COMPACTION_SETTING_DESCRIPTORS,
  ...FOOTER_SETTING_DESCRIPTORS,
  ...USAGE_SETTING_DESCRIPTORS,
  ...IMAGE_SETTING_DESCRIPTORS,
];
const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);
export const prepareSettingUpdate = Effect.fn("OpenAIConfig.prepareSettingUpdate")(function* (
  id: string,
  rawValue: string,
) {
  const descriptor = SETTINGS_OPTION_BY_ID.get(id);
  if (!descriptor)
    return yield* new InvalidSettingError({ id, message: `Unknown setting: ${id}.` });
  const parsedValue = yield* Schema.decodeUnknownEffect(descriptor.decoder)(rawValue).pipe(
    Effect.mapError(() => new InvalidSettingError({ id, message: `Invalid value for ${id}.` })),
  );
  const separator = descriptor.id.indexOf(".");
  if (separator < 0)
    return (current: JsonObject): JsonObject => ({ ...current, [descriptor.id]: parsedValue });
  return sectionSettingValue(
    descriptor.id.slice(0, separator),
    descriptor.id.slice(separator + 1),
    parsedValue,
  );
});
