/** Pure slash-command argument completion shared by extension settings surfaces. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isJsonObject, type JsonObject, type JsonValue } from "./platform/json-document.ts";

export interface SettingsCompletionDescriptor {
  readonly id: string;
  readonly description: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

export interface SettingsCompletionChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Completes `/…-settings` arguments against option descriptors plus caller-supplied extra
 * verbs (help/diagnostics), preserving descriptor order, case-insensitive prefix matching,
 * and the host contract of `null` (never an empty array) when nothing matches.
 */
export const completeSettingsArguments = (
  prefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice> = [],
): SettingsCompletionChoice[] | null => {
  const normalized = prefix.replace(/^\s+/, "");
  const [head = "", ...rest] = normalized.split(/\s+/);
  if (rest.length === 0 && !/\s$/.test(normalized)) {
    const query = head.toLowerCase();
    const choices = [
      ...descriptors.map((descriptor) => ({
        value: descriptor.id,
        label: descriptor.id,
        description: descriptor.description,
      })),
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
      value: `${head} ${value}`,
      label: `${head} ${value}`,
      description: descriptor.description,
    }));
  return matches.length > 0 ? matches : null;
};

/**
 * Write-side twin of `completeSettingsArguments`: build a document patch that assigns one
 * settings value into its dotted section (`section` + `key`, e.g. `"footer"` + `"mode"`).
 * A missing section is created; a non-object section value is replaced.
 */
export const sectionSettingValue =
  (section: string, key: string, value: JsonValue): ((current: JsonObject) => JsonObject) =>
  (current) => {
    const existing = current[section];
    const sectionObject: JsonObject = isJsonObject(existing) ? existing : {};
    return { ...current, [section]: { ...sectionObject, [key]: value } };
  };

/** Shared settings error for unknown setting ids and values that fail their decoder. */
export class InvalidSettingError extends Schema.TaggedError<InvalidSettingError>()(
  "InvalidSettingError",
  { id: Schema.String, message: Schema.String },
) {}

/** One user-facing settings option: presentation metadata plus a wire decoder. */
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

/**
 * Builds the shared settings-update decoder over a package's descriptors: unknown ids and values
 * that fail their decoder fail with `InvalidSettingError`, while a known id yields a document
 * patch assigning the decoded value to its top-level key or its dotted section.
 */
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
