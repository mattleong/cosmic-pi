import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { JsonObject } from "pi-cosmic-core";
import type { ResolvedConfig } from "./schema.ts";
import { FiniteNumberSchema, FOOTER_MODES, FooterModeSchema } from "./schema.ts";

export type SettingsOptionSection = "usage" | "footer";

export class InvalidSettingError extends Schema.TaggedError<InvalidSettingError>()(
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

const decode =
  <A extends boolean | number | string>(id: string, schema: Schema.Decoder<A>) =>
  (raw: string) =>
    Schema.decodeUnknownEffect(schema)(raw).pipe(
      Effect.mapError(() => new InvalidSettingError({ id, message: `Invalid value for ${id}.` })),
    );
const decodeJson = (id: string, schema: Schema.Decoder<boolean | number>) =>
  decode(id, Schema.fromJsonString(schema));

export const SETTINGS_OPTION_DESCRIPTORS: readonly SettingsOptionDescriptor[] = [
  {
    id: "usage.enabled",
    section: "usage",
    key: "enabled",
    label: "Usage display",
    currentValue: (cfg) => String(cfg.usage.enabled),
    values: ["true", "false"],
    description: "Fetch and display xAI subscription usage windows.",
    decode: decodeJson("usage.enabled", Schema.Boolean),
  },
  {
    id: "usage.refreshIntervalMs",
    section: "usage",
    key: "refreshIntervalMs",
    label: "Usage refresh",
    currentValue: (cfg) => String(cfg.usage.refreshIntervalMs),
    values: ["15000", "30000", "60000", "120000", "300000", "600000"],
    description: "Usage refresh interval in milliseconds.",
    decode: decodeJson("usage.refreshIntervalMs", FiniteNumberSchema),
  },
  {
    id: "usage.showOnlyOnSubscriptionModels",
    section: "usage",
    key: "showOnlyOnSubscriptionModels",
    label: "Usage only on OAuth",
    currentValue: (cfg) => String(cfg.usage.showOnlyOnSubscriptionModels),
    values: ["true", "false"],
    description: "Only show usage when the current xAI model uses subscription/OAuth auth.",
    decode: decodeJson("usage.showOnlyOnSubscriptionModels", Schema.Boolean),
  },
  {
    id: "usage.showResetTimes",
    section: "usage",
    key: "showResetTimes",
    label: "Usage reset times",
    currentValue: (cfg) => String(cfg.usage.showResetTimes),
    values: ["true", "false"],
    description: "Include compact reset countdowns and local reset times.",
    decode: decodeJson("usage.showResetTimes", Schema.Boolean),
  },
  {
    id: "footer.mode",
    section: "footer",
    key: "mode",
    label: "Footer mode",
    currentValue: (cfg) => cfg.footer.mode,
    values: FOOTER_MODES,
    description:
      "replace = custom footer line, status = pi status line, off = no Better xAI footer/status.",
    decode: decode("footer.mode", FooterModeSchema),
  },
];
const SETTINGS_OPTION_BY_ID = new Map(
  SETTINGS_OPTION_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]),
);
const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
const isJsonObject = (value: unknown): value is JsonObject => Schema.is(JsonObjectSchema)(value);

export type RawConfigUpdate = (current: JsonObject) => JsonObject;

export const decodeSettingUpdate = Effect.fn("XaiConfig.decodeSettingUpdate")(function* (
  id: string,
  rawValue: string,
) {
  const descriptor = SETTINGS_OPTION_BY_ID.get(id);
  if (!descriptor) return (current: JsonObject) => ({ ...current });
  const parsedValue = yield* descriptor.decode(rawValue);
  return ((current: JsonObject) => {
    const next: JsonObject = { ...current };
    const currentSection = next[descriptor.section];
    const section: JsonObject = isJsonObject(currentSection) ? { ...currentSection } : {};
    section[descriptor.key] = parsedValue;
    next[descriptor.section] = section;
    return next;
  }) satisfies RawConfigUpdate;
});
