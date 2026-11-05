import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clipText } from "./display.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "./platform/json-document.ts";
import { safeTextPrefix } from "./text.ts";
import { lastIndexOfFrom } from "./text-scan.ts";

interface SettingsCompletionDescriptor {
  readonly id: string;
  /** The setting's short name; completions describe each id with it, never the full description. */
  readonly label: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

interface SettingsCompletionChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/** Pi's completion list gives each description about this many columns before cutting mid-word. */
const COMPLETION_DESCRIPTION_LIMIT = 20;

/** Cuts a completion description at the last whole word that fits, so the list never ends mid-word. */
const completionDescription = (text: string): string => {
  if (text.length <= COMPLETION_DESCRIPTION_LIMIT) return text;
  const head = safeTextPrefix(text, COMPLETION_DESCRIPTION_LIMIT);
  const space = lastIndexOfFrom(head, " ", COMPLETION_DESCRIPTION_LIMIT - 1);
  return space > 0
    ? `${Str.trimEnd(Fn.pipe(head, Str.slice(0, space)))}…`
    : clipText(text, COMPLETION_DESCRIPTION_LIMIT);
};

const nonEmpty = (matches: SettingsCompletionChoice[]): SettingsCompletionChoice[] | null =>
  matches.length > 0
    ? Arr.map(matches, (choice) =>
        Object.assign({}, choice, { description: completionDescription(choice.description) }),
      )
    : null;

const completeSettingIds = (
  head: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice>,
  scopes: ReadonlyArray<SettingsCompletionChoice>,
): SettingsCompletionChoice[] | null => {
  const query = Str.toLowerCase(head);
  const choices = [
    ...Arr.map(descriptors, (descriptor) => ({
      value: descriptor.id,
      label: descriptor.id,
      description: descriptor.label,
    })),
    ...scopes,
    ...extras,
  ];
  return nonEmpty(
    Arr.filter(choices, (choice) => Fn.pipe(choice.value, Str.toLowerCase, Str.startsWith(query))),
  );
};

const completeSettingValues = (
  head: string,
  valuePrefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
): SettingsCompletionChoice[] | null => {
  const headId = Str.toLowerCase(head);
  const descriptor = Option.getOrUndefined(
    Arr.findFirst(descriptors, (entry) => Str.toLowerCase(entry.id) === headId),
  );
  if (!descriptor) return null;
  const query = Str.toLowerCase(valuePrefix);
  return nonEmpty(
    Fn.pipe(
      descriptor.values ?? [],
      Arr.filter((value) => Fn.pipe(value, Str.toLowerCase, Str.startsWith(query))),
      Arr.map((value) => ({
        value: `${descriptor.id} ${value}`,
        label: `${descriptor.id} ${value}`,
        description: descriptor.label,
      })),
    ),
  );
};

export const completeSettingsArguments = (
  prefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice> = [],
  scopes: ReadonlyArray<SettingsCompletionChoice> = [],
): SettingsCompletionChoice[] | null => {
  const normalized = Fn.pipe(prefix, Str.replace(/^\s+/, ""));
  const scoped = /^(\S+)\s+([\s\S]*)$/u.exec(normalized);
  const scope =
    scoped && Option.getOrUndefined(Arr.findFirst(scopes, (choice) => choice.value === scoped[1]));
  if (scoped && scope) {
    const inner = completeSettingsArguments(scoped[2] ?? "", descriptors);
    return inner === null
      ? null
      : Arr.map(inner, (choice) =>
          Object.assign({}, choice, {
            value: `${scope.value} ${choice.value}`,
            label: `${scope.value} ${choice.label}`,
          }),
        );
  }
  const [head, ...rest] = Str.split(normalized, /\s+/);
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

// A rejected value is quoted within one notice line beside its setting's name.
const REJECTED_VALUE_COLUMNS = 24;

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
  /**
   * What a free-form value must be, phrased to follow the setting's name, such as
   * `must be a duration such as 30s or 2m`. A rejected value states it in place of the generic wording.
   */
  readonly rule?: string | undefined;
  readonly currentValue: (config: Config) => string;
}

export const BooleanFromJsonSchema = Schema.fromJsonString(Schema.Boolean);
export const FiniteNumberFromJsonSchema = Schema.fromJsonString(Schema.Finite);

export const decodeSettingUpdate = <Config>(
  descriptors: ReadonlyArray<Pick<SettingsOptionDescriptor<Config>, "id" | "decoder" | "rule">>,
) =>
  Effect.fn("Settings.decodeSettingUpdate")(function* (id: string, rawValue: string) {
    const descriptor = Option.getOrUndefined(
      Arr.findFirst(descriptors, (entry) => entry.id === id),
    );
    if (!descriptor)
      return yield* InvalidSettingError.make({ id, message: `Unknown setting: ${id}` });
    // Leads with the id so the settings shell can name the setting: `Label (id) <rule>`.
    const rule =
      descriptor.rule === undefined || Str.isEmpty(Str.trim(descriptor.rule))
        ? `can't be set to ${clipText(Str.trim(rawValue), REJECTED_VALUE_COLUMNS)}`
        : Str.trim(descriptor.rule);
    const parsedValue = yield* Schema.decodeEffect(descriptor.decoder)(rawValue).pipe(
      Effect.mapError(() => InvalidSettingError.make({ id, message: `${id} ${rule}` })),
    );
    const separator = Fn.pipe(id, Str.indexOf("."));
    if (Option.isNone(separator))
      return (current: JsonObject): JsonObject => ({ ...current, [id]: parsedValue });
    return sectionSettingValue(
      Fn.pipe(id, Str.slice(0, separator.value)),
      Fn.pipe(id, Str.slice(separator.value + 1)),
      parsedValue,
    );
  });
