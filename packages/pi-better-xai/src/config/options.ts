import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sectionSettingValue } from "pi-cosmic-core";
import type { ResolvedConfig } from "./schema.ts";
import { FiniteNumberSchema, FOOTER_MODES, FooterModeSchema } from "./schema.ts";

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
const FiniteNumberFromJsonSchema = Schema.fromJsonString(FiniteNumberSchema);

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    label: "Usage display",
    currentValue: (cfg) => String(cfg.usage.enabled),
    values: ["true", "false"],
    description: "Fetch and display xAI subscription usage windows.",
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
  {
    id: "footer.mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer line, status = pi status line, off = no Better xAI footer/status.",
    decoder: FooterModeSchema,
  },
];
const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);

export const decodeSettingUpdate = Effect.fn("XaiConfig.decodeSettingUpdate")(function* (
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
  return sectionSettingValue(
    descriptor.id.slice(0, separator),
    descriptor.id.slice(separator + 1),
    parsedValue,
  );
});
