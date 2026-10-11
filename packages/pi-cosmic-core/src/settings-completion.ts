import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isJsonObject, type JsonObject, type JsonValue } from "./platform/json-document.ts";
import type { SubscriptionUsageConfig } from "./usage-controller.ts";

interface SettingsCompletionDescriptor {
  readonly id: string;
  readonly description: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

interface SettingsCompletionChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

export const completeSettingsArguments = (
  prefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice> = [],
  scopes: ReadonlyArray<SettingsCompletionChoice> = [],
): SettingsCompletionChoice[] | null => {
  const normalized = prefix.replace(/^\s+/, "");
  const scoped = /^(\S+)\s+([\s\S]*)$/u.exec(normalized);
  const scope = scoped && scopes.find((choice) => choice.value === scoped[1]);
  if (scoped && scope) {
    const inner = completeSettingsArguments(scoped[2] ?? "", descriptors);
    return (
      inner?.map((choice) => ({
        ...choice,
        value: `${scope.value} ${choice.value}`,
        label: `${scope.value} ${choice.label}`,
      })) ?? null
    );
  }
  const [head = "", ...rest] = normalized.split(/\s+/);
  if (rest.length === 0 && !/\s$/.test(normalized)) {
    const query = head.toLowerCase();
    const choices = [
      ...descriptors.map((descriptor) => ({
        value: descriptor.id,
        label: descriptor.id,
        description: descriptor.description,
      })),
      ...scopes,
      ...extras,
    ];
    const matches = choices.filter((choice) => choice.value.toLowerCase().startsWith(query));
    return matches.length > 0 ? matches : null;
  }
  const headId = head.toLowerCase();
  const descriptor = descriptors.find((entry) => entry.id.toLowerCase() === headId);
  if (!descriptor) return null;
  const valuePrefix = (rest[0] ?? "").toLowerCase();
  const matches = (descriptor.values ?? [])
    .filter((value) => value.toLowerCase().startsWith(valuePrefix))
    .map((value) => ({
      value: `${descriptor.id} ${value}`,
      label: `${descriptor.id} ${value}`,
      description: descriptor.description,
    }));
  return matches.length > 0 ? matches : null;
};

export const sectionSettingValue =
  (section: string, key: string, value: JsonValue): ((current: JsonObject) => JsonObject) =>
  (current) => {
    const existing = current[section];
    const sectionObject: JsonObject = isJsonObject(existing) ? existing : {};
    return { ...current, [section]: { ...sectionObject, [key]: value } };
  };

export class InvalidSettingError extends Schema.TaggedError<InvalidSettingError>()(
  "InvalidSettingError",
  { id: Schema.String, message: Schema.String },
) {}

export interface SettingsOptionDescriptor<Config = unknown> {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly values?: readonly string[] | undefined;
  readonly decoder: Schema.Decoder<boolean | number | string>;
  readonly currentValue: (config: Config) => string;
}

export const BooleanFromJsonSchema = Schema.fromJsonString(Schema.Boolean);
export const FiniteNumberFromJsonSchema = Schema.fromJsonString(
  Schema.Number.check(Schema.isFinite()),
);

export const makeUsageSettingDescriptors = <
  Config extends { readonly usage: SubscriptionUsageConfig },
>(
  subscriptionDescription: string,
): readonly SettingsOptionDescriptor<Config>[] => [
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
    description: subscriptionDescription,
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

export const decodeSettingUpdate = <Config>(
  descriptors: ReadonlyArray<Pick<SettingsOptionDescriptor<Config>, "id" | "decoder">>,
) =>
  Effect.fn("Settings.decodeSettingUpdate")(function* (id: string, rawValue: string) {
    const descriptor = descriptors.find((entry) => entry.id === id);
    if (!descriptor)
      return yield* new InvalidSettingError({ id, message: `Unknown setting: ${id}.` });
    const parsedValue = yield* Schema.decodeUnknownEffect(descriptor.decoder)(rawValue).pipe(
      Effect.mapError(() => new InvalidSettingError({ id, message: `Invalid value for ${id}.` })),
    );
    const separator = id.indexOf(".");
    if (separator < 0)
      return (current: JsonObject): JsonObject => ({ ...current, [id]: parsedValue });
    return sectionSettingValue(id.slice(0, separator), id.slice(separator + 1), parsedValue);
  });
