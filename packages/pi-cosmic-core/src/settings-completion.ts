import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isJsonObject, type JsonObject, type JsonValue } from "./platform/json-document.ts";

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

const nonEmpty = (matches: SettingsCompletionChoice[]): SettingsCompletionChoice[] | null =>
  matches.length > 0 ? matches : null;

const completeSettingIds = (
  head: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice>,
  scopes: ReadonlyArray<SettingsCompletionChoice>,
): SettingsCompletionChoice[] | null => {
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
  return nonEmpty(choices.filter((choice) => choice.value.toLowerCase().startsWith(query)));
};

const completeSettingValues = (
  head: string,
  valuePrefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
): SettingsCompletionChoice[] | null => {
  const headId = head.toLowerCase();
  const descriptor = descriptors.find((entry) => entry.id.toLowerCase() === headId);
  if (!descriptor) return null;
  const query = valuePrefix.toLowerCase();
  return nonEmpty(
    (descriptor.values ?? [])
      .filter((value) => value.toLowerCase().startsWith(query))
      .map((value) => ({
        value: `${descriptor.id} ${value}`,
        label: `${descriptor.id} ${value}`,
        description: descriptor.description,
      })),
  );
};

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
      inner?.map((choice) =>
        Object.assign({}, choice, {
          value: `${scope.value} ${choice.value}`,
          label: `${scope.value} ${choice.label}`,
        }),
      ) ?? null
    );
  }
  const [head = "", ...rest] = normalized.split(/\s+/);
  return rest.length === 0 && !/\s$/.test(normalized)
    ? completeSettingIds(head, descriptors, extras, scopes)
    : completeSettingValues(head, rest[0] ?? "", descriptors);
};

export const sectionSettingValue =
  (section: string, key: string, value: JsonValue): ((current: JsonObject) => JsonObject) =>
  (current) => {
    const existing = current[section];
    const sectionObject: JsonObject = isJsonObject(existing) ? existing : {};
    return { ...current, [section]: { ...sectionObject, [key]: value } };
  };

export class InvalidSettingError extends Schema.TaggedError<
  InvalidSettingError,
  { readonly brand: unique symbol }
>()("InvalidSettingError", { id: Schema.String, message: Schema.String }) {}

export interface SettingsOptionDescriptor<Config = unknown> {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly values?: readonly string[] | undefined;
  readonly decoder: Schema.Decoder<boolean | number | string>;
  readonly currentValue: (config: Config) => string;
}

export const BooleanFromJsonSchema = Schema.fromJsonString(Schema.Boolean);
export const FiniteNumberFromJsonSchema = Schema.fromJsonString(Schema.Finite);

export const decodeSettingUpdate = <Config>(
  descriptors: ReadonlyArray<Pick<SettingsOptionDescriptor<Config>, "id" | "decoder">>,
) =>
  Effect.fn("Settings.decodeSettingUpdate")(function* (id: string, rawValue: string) {
    const descriptor = descriptors.find((entry) => entry.id === id);
    if (!descriptor)
      return yield* InvalidSettingError.make({ id, message: `Unknown setting: ${id}.` });
    const parsedValue = yield* Schema.decodeEffect(descriptor.decoder)(rawValue).pipe(
      Effect.mapError(() => InvalidSettingError.make({ id, message: `Invalid value for ${id}.` })),
    );
    const separator = id.indexOf(".");
    if (separator < 0)
      return (current: JsonObject): JsonObject => ({ ...current, [id]: parsedValue });
    return sectionSettingValue(id.slice(0, separator), id.slice(separator + 1), parsedValue);
  });
