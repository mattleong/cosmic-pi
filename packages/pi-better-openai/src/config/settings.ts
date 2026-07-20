import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isRecord } from "../utils.ts";
import type { ResolvedConfig } from "./schema.ts";
import {
  FOOTER_MODES,
  FooterModeSchema,
  IMAGE_OUTPUT_FORMATS,
  IMAGE_SAVE_MODES,
  ImageOutputFormatSchema,
  ImageSaveModeSchema,
} from "./schema.ts";

export type SettingsOptionSection = "root" | "usage" | "footer" | "image";
export class InvalidSettingError extends Schema.TaggedErrorClass<InvalidSettingError>()(
  "InvalidSettingError",
  { id: Schema.String, message: Schema.String },
) {}
export type SettingsOptionDescriptor = {
  id: string;
  section: SettingsOptionSection;
  key: string;
  label: string;
  description: string;
  values?: readonly string[];
  decode(rawValue: string): Effect.Effect<boolean | number | string, InvalidSettingError>;
  currentValue(cfg: ResolvedConfig): string;
};
const decodeJson = (id: string, schema: Schema.Decoder<boolean | number>) => (raw: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(() => new InvalidSettingError({ id, message: `Invalid value for ${id}.` })),
  );
const decodeLiteral = (id: string, schema: Schema.Decoder<string>) => (raw: string) =>
  Schema.decodeUnknownEffect(schema)(raw).pipe(
    Effect.mapError(() => new InvalidSettingError({ id, message: `Invalid value for ${id}.` })),
  );
const finiteNumber = Schema.Number.check(Schema.isFinite());
const boolean = (id: string) => decodeJson(id, Schema.Boolean);
const number = (id: string) => decodeJson(id, finiteNumber);

export const FAST_SETTING_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "persistState",
    section: "root",
    key: "persistState",
    label: "Persist fast state",
    currentValue: (cfg) => String(cfg.persistState),
    values: ["true", "false"],
    description: "Remember fast-mode state across sessions.",
    decode: boolean("persistState"),
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
    decode: decodeLiteral("footer.mode", FooterModeSchema),
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
    decode: boolean("usage.enabled"),
  },
  {
    id: "usage.refreshIntervalMs",
    section: "usage",
    key: "refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => String(cfg.usage.refreshIntervalMs),
    values: ["15000", "30000", "60000", "120000", "300000", "600000"],
    description: "Usage refresh interval in milliseconds.",
    decode: number("usage.refreshIntervalMs"),
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    section: "usage",
    key: "showOnlyOnSubscriptionModels",
    label: "Usage only on OAuth",
    currentValue: (cfg) => String(cfg.usage.showOnlyOnSubscriptionModels),
    values: ["true", "false"],
    description: "Only show usage when the current OpenAI model uses subscription/OAuth auth.",
    decode: boolean("usage.showOnlyOnSubscriptionModels"),
  },
  {
    id: "usage.showResetTimes",
    section: "usage",
    key: "showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => String(cfg.usage.showResetTimes),
    values: ["true", "false"],
    description: "Include compact reset countdowns and local reset times.",
    decode: boolean("usage.showResetTimes"),
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
    decode: boolean("image.enabled"),
  },
  {
    id: "image.defaultModel",
    section: "image",
    key: "defaultModel",
    label: "Image model",
    currentValue: (cfg) => cfg.image.defaultModel,
    values: ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5"],
    description: "Mainline model used for image generation when current model is not openai-codex.",
    decode: (raw) =>
      raw.trim()
        ? Effect.succeed(raw)
        : Effect.fail(
            new InvalidSettingError({
              id: "image.defaultModel",
              message: "Invalid value for image.defaultModel.",
            }),
          ),
  },
  {
    id: "image.defaultSave",
    section: "image",
    key: "defaultSave",
    label: "Image save",
    currentValue: (cfg) => cfg.image.defaultSave,
    values: IMAGE_SAVE_MODES,
    description: "Where generated images are saved by default.",
    decode: decodeLiteral("image.defaultSave", ImageSaveModeSchema),
  },
  {
    id: "image.outputFormat",
    section: "image",
    key: "outputFormat",
    label: "Image format",
    currentValue: (cfg) => cfg.image.outputFormat,
    values: IMAGE_OUTPUT_FORMATS,
    description: "Generated image file format.",
    decode: decodeLiteral("image.outputFormat", ImageOutputFormatSchema),
  },
  {
    id: "image.timeoutMs",
    section: "image",
    key: "timeoutMs",
    label: "Image timeout",
    currentValue: (cfg) => String(cfg.image.timeoutMs),
    values: ["30000", "60000", "120000", "180000", "300000"],
    description: "Image request timeout in milliseconds.",
    decode: number("image.timeoutMs"),
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

export const applySettingToRawConfig = Effect.fn("OpenAIConfig.applySetting")(function* (
  current: Record<string, unknown>,
  id: string,
  rawValue: string,
  context: SettingPatchContext = {},
) {
  const next: Record<string, unknown> = { ...current };
  if (id === "fast.enabled") {
    const enabled = yield* boolean(id)(rawValue);
    if (context.persistState) {
      next.active = context.active ?? enabled;
      next.desiredActive = context.desiredActive ?? enabled;
    }
    return next;
  }
  const descriptor = SETTINGS_OPTION_BY_ID.get(id);
  if (!descriptor) return next;
  const parsedValue = yield* descriptor.decode(rawValue);
  if (descriptor.section === "root") next[descriptor.key] = parsedValue;
  else {
    const currentSection = next[descriptor.section];
    const section = isRecord(currentSection) ? { ...currentSection } : {};
    section[descriptor.key] = parsedValue;
    next[descriptor.section] = section;
  }
  return next;
});
