import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Static, TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Compile } from "typebox/compile";
import { Check, Convert, Errors } from "typebox/value";
import { clipText } from "../display.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../platform/json-document.ts";

const MAX_REPORTED_ISSUES = 8;
const MAX_ECHO_CHARS = 600;
const MAX_ECHO_STRING_CHARS = 80;
const MAX_REPORTED_VALUE_CHARS = 60;

const decodeSerializedSchema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decodeArgumentsObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson),
);
const decodeJson = Schema.decodeUnknownOption(Schema.MutableJson);

const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);
const isJsonRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);

/**
 * Dotted property paths, such as `contains` or `agents.name`, whose whitespace-only text is
 * meaningful and kept. Array items take their array's path. Empty strings are still dropped.
 */
export type ToolWhitespaceFields = ReadonlyArray<string>;

const fieldPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

const isBlank = (value: JsonValue, keepsWhitespace: boolean): boolean =>
  Predicate.isString(value) && (keepsWhitespace ? value : value.trim()).length === 0;

// Pi compiles the property schema the same way and keeps the null when compilation fails.
const compileSchema = Option.liftThrowable((schema: Schema.JsonObject) => Compile(schema));

/**
 * Like Pi's `normalizeOptionalNulls`, a null is dropped only when the property schema rejects it
 * and is not a `$ref`, so a nullable field keeps its explicit null.
 */
const rejectsNull = (schema: Schema.JsonObject): boolean =>
  !Predicate.isString(schema.$ref) &&
  Option.exists(compileSchema(schema), (validator) => !validator.Check(null));

interface Omission {
  readonly keepWhitespace: ToolWhitespaceFields;
  /** Memoizes `rejectsNull` per property schema, as Pi caches compiled validators. */
  readonly nullRejections: WeakMap<Schema.JsonObject, boolean>;
}

const isOmitted = (
  value: JsonValue,
  schema: Schema.JsonObject,
  path: string,
  { keepWhitespace, nullRejections }: Omission,
): boolean => {
  if (value !== null) return isBlank(value, keepWhitespace.includes(path));
  const known = nullRejections.get(schema);
  if (known !== undefined) return known;
  const rejects = rejectsNull(schema);
  nullRejections.set(schema, rejects);
  return rejects;
};

const withoutBlankOptionalProperties = (
  value: JsonObject,
  schema: Schema.JsonObject,
  path: string,
  omission: Omission,
): JsonObject => {
  const properties: Schema.JsonObject = isJsonRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      const propertySchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
      const propertyPath = fieldPath(path, key);
      if (
        isJsonRecord(propertySchema) &&
        !required.includes(key) &&
        isOmitted(item, propertySchema, propertyPath, omission)
      )
        return [];
      return [[key, withoutBlankOptionals(item, propertySchema, propertyPath, omission)] as const];
    }),
  );
};

const withoutBlankOptionals = (
  value: JsonValue,
  schema: Schema.Json | undefined,
  path: string,
  omission: Omission,
): JsonValue => {
  if (!isJsonRecord(schema)) return value;
  if (Array.isArray(value))
    return value.map((item) => withoutBlankOptionals(item, schema.items, path, omission));
  return isJsonObject(value)
    ? withoutBlankOptionalProperties(value, schema, path, omission)
    : value;
};

/**
 * Builds a pure normalizer of decoded tool arguments for a TypeBox or JSON Schema parameter
 * schema. It returns a copy without the declared optional properties whose value is empty or only
 * whitespace, unless `keepWhitespace` names them, or null where the property schema rejects null,
 * through nested object properties and array items, so models that send placeholders get the
 * defaults. Required and undeclared properties stay for validation to report. The result is still
 * unvalidated; `toolArgumentPreparer` applies it before validating.
 */
export const omitBlankOptionalArguments = (
  parameters: TSchema,
  keepWhitespace: ToolWhitespaceFields = [],
): ((args: JsonObject) => JsonObject) => {
  const schema = decodeSerializedSchema(JSON.stringify(parameters));
  const omission: Omission = { keepWhitespace, nullRejections: new WeakMap() };
  return (args) =>
    isJsonRecord(schema) ? withoutBlankOptionalProperties(args, schema, "", omission) : { ...args };
};

interface Location {
  /** Display path with array indexes, such as `agents[0].task`. */
  readonly path: string;
  /** Dotted property path without indexes, such as `agents.task`. */
  readonly field: string;
}

const childEntries = (
  value: Schema.Json,
  { path, field }: Location,
): ReadonlyArray<readonly [Location, Schema.Json]> => {
  if (isJsonArray(value))
    return value.map((item, index) => [{ path: `${path}[${index}]`, field }, item] as const);
  return isJsonRecord(value)
    ? Object.entries(value).map(
        ([key, item]) =>
          [{ path: fieldPath(path, key), field: fieldPath(field, key) }, item] as const,
      )
    : [];
};

const firstBlankString = (
  value: Schema.Json,
  location: Location,
  keepWhitespace: ToolWhitespaceFields,
): string | undefined => {
  if (Predicate.isString(value))
    return isBlank(value, keepWhitespace.includes(location.field))
      ? location.path || "value"
      : undefined;
  for (const [childLocation, child] of childEntries(value, location)) {
    const blank = firstBlankString(child, childLocation, keepWhitespace);
    if (blank !== undefined) return blank;
  }
  return undefined;
};

/**
 * Location of the first string that is empty or only whitespace, such as `agents[0].task`.
 * Fields that `keepWhitespace` names count as blank only when empty.
 */
export const blankStringPath = (
  value: Schema.Json,
  keepWhitespace: ToolWhitespaceFields = [],
): string | undefined => firstBlankString(value, { path: "", field: "" }, keepWhitespace);

const pathSegments = (pointer: string): ReadonlyArray<string> =>
  pointer
    .replace(/^#?\/?/u, "")
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));

const valueAt = (root: Schema.Json, pointer: string): Schema.Json | undefined =>
  pathSegments(pointer).reduce<Schema.Json | undefined>((node, segment) => {
    if (node === undefined) return undefined;
    if (isJsonArray(node)) return node[Number(segment)];
    return isJsonRecord(node) ? node[segment] : undefined;
  }, root);

const displayPath = (pointer: string, root: string): string =>
  pathSegments(pointer).reduce((label, segment) => {
    if (/^\d+$/u.test(segment)) return `${label}[${segment}]`;
    return label === root ? segment : `${label}.${segment}`;
  }, root);

const reportedValue = (value: Schema.Json | undefined): string =>
  value === undefined ? "nothing" : clipText(JSON.stringify(value), MAX_REPORTED_VALUE_CHARS);

const acceptedFields = (schema: Schema.Json | undefined): ReadonlyArray<string> => {
  const properties = isJsonRecord(schema) ? schema.properties : undefined;
  return isJsonRecord(properties) ? Object.keys(properties) : [];
};

/** Field names that models trained on other harnesses send, mapped to this tool's field. */
export type ToolFieldAliases = Readonly<Record<string, string>>;

/**
 * The accepted field an unknown key most likely meant: an alias, the camelCase spelling, or its
 * singular or plural form, such as `task` for `prompt` given `{ prompt: "task" }`.
 */
export const replacementField = (
  key: string,
  accepted: ReadonlyArray<string>,
  aliases: ToolFieldAliases = {},
): string | undefined => {
  const camel = key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  const alias = [key, camel].find((name) => Object.hasOwn(aliases, name));
  return [
    alias === undefined ? undefined : aliases[alias],
    camel,
    `${camel}s`,
    camel.replace(/s$/u, ""),
  ].find(
    (candidate) => candidate !== undefined && candidate !== key && accepted.includes(candidate),
  );
};

const unknownFieldsIssue = (
  subject: string,
  keys: ReadonlyArray<string>,
  accepted: ReadonlyArray<string>,
  aliases: ToolFieldAliases,
): string => {
  const named = keys.map((key) => {
    const replacement = replacementField(key, accepted, aliases);
    return replacement ? `"${key}" (use "${replacement}")` : `"${key}"`;
  });
  const fields =
    accepted.length > 0 ? `accepted fields: ${accepted.join(", ")}` : "it takes no fields";
  return `${subject} does not accept ${named.join(", ")}; ${fields}.`;
};

interface IssueContext {
  readonly toolName: string;
  readonly schema: Schema.Json;
  readonly aliases: ToolFieldAliases;
}

const issueText = (
  error: TLocalizedValidationError,
  args: Schema.Json,
  { toolName, schema, aliases }: IssueContext,
): string => {
  const subject = displayPath(error.instancePath, toolName);
  if (error.keyword === "additionalProperties")
    return unknownFieldsIssue(
      subject,
      error.params.additionalProperties,
      acceptedFields(valueAt(schema, error.schemaPath)),
      aliases,
    );
  if (error.keyword === "enum")
    return `${subject} must be one of ${error.params.allowedValues.map(String).join(", ")}; received ${reportedValue(valueAt(args, error.instancePath))}.`;
  if (error.keyword === "required")
    return `${error.params.requiredProperties
      .map((field) => displayPath(`${error.instancePath}/${field}`, toolName))
      .join(", ")} is required.`;
  return `${subject} ${error.message}.`;
};

const isWithin = (pointer: string, ancestor: string): boolean =>
  pointer === ancestor || pointer.startsWith(`${ancestor}/`);

interface Discriminant {
  readonly error: TLocalizedValidationError;
  /** Instance pointer of the value the anyOf validates. */
  readonly value: string;
  /** Schema pointers of the anyOf and of the branch the error rules out. */
  readonly union: string;
  readonly branch: string;
}

// An enum or const that is a direct property of an anyOf branch, such as `.../anyOf/1/properties/mode`.
const DISCRIMINANT_SCHEMA_PATH = /^((.*)\/anyOf\/\d+)\/properties\/([^/]+)$/u;

const isEnumOrConst = (schema: Schema.Json | undefined): boolean =>
  isJsonRecord(schema) && (Object.hasOwn(schema, "enum") || Object.hasOwn(schema, "const"));

/** A property is a union's discriminant only when every branch declares it as an enum or const. */
const isUnionDiscriminant = (schema: Schema.Json, union: string, property: string): boolean => {
  const node = valueAt(schema, union);
  return (
    isJsonRecord(node) &&
    isJsonArray(node.anyOf) &&
    node.anyOf.every(
      (branch) =>
        isJsonRecord(branch) &&
        isJsonRecord(branch.properties) &&
        Object.hasOwn(branch.properties, property) &&
        isEnumOrConst(branch.properties[property]),
    )
  );
};

const discriminant = (
  error: TLocalizedValidationError,
  schema: Schema.Json,
): Discriminant | undefined => {
  if (error.keyword !== "enum" && error.keyword !== "const") return undefined;
  const [, branch, union, encodedProperty] = DISCRIMINANT_SCHEMA_PATH.exec(error.schemaPath) ?? [];
  if (branch === undefined || union === undefined || encodedProperty === undefined)
    return undefined;
  const [property] = pathSegments(encodedProperty);
  if (property === undefined || !isUnionDiscriminant(schema, union, property)) return undefined;
  const value = error.instancePath.slice(0, Math.max(0, error.instancePath.lastIndexOf("/")));
  return { error, value, union, branch };
};

const unionKey = ({ value, union }: Discriminant): string => `${value}#${union}`;

const unionBranchCount = (schema: Schema.Json, union: string): number => {
  const node = valueAt(schema, union);
  return isJsonRecord(node) && isJsonArray(node.anyOf) ? node.anyOf.length : 0;
};

const allowedValues = (error: TLocalizedValidationError): ReadonlyArray<unknown> => {
  if (error.keyword === "enum") return error.params.allowedValues;
  return error.keyword === "const" ? [error.params.allowedValue] : [];
};

/**
 * An enum or const property that every anyOf branch declares, such as `mode`, selects the branches
 * its received value does not rule out, so only their issues are reported instead of every branch's mismatches.
 * When it rules out every branch, that property is reported once with all allowed values.
 */
const selectedBranchErrors = (
  errors: ReadonlyArray<TLocalizedValidationError>,
  schema: Schema.Json,
): ReadonlyArray<TLocalizedValidationError> => {
  const discriminants = errors.flatMap((error) => discriminant(error, schema) ?? []);
  const ruledOut = new Map<string, Set<string>>();
  for (const entry of discriminants)
    ruledOut.set(unionKey(entry), (ruledOut.get(unionKey(entry)) ?? new Set()).add(entry.branch));
  const rulesOutAll = (entry: Discriminant): boolean =>
    (ruledOut.get(unionKey(entry))?.size ?? 0) >= unionBranchCount(schema, entry.union);
  const unmatched = (error: TLocalizedValidationError): boolean =>
    discriminants.some((entry) => entry.error === error && rulesOutAll(entry));
  const isUnselected = (error: TLocalizedValidationError): boolean =>
    discriminants.some((entry) => {
      if (!isWithin(error.instancePath, entry.value)) return false;
      if (error.keyword === "anyOf")
        return error.instancePath === entry.value && error.schemaPath === entry.union;
      if (!rulesOutAll(entry)) return isWithin(error.schemaPath, entry.branch);
      return isWithin(error.schemaPath, `${entry.union}/anyOf`) && !unmatched(error);
    });
  const selected = errors.filter((error) => !isUnselected(error));
  const reported = new Set<string>();
  return selected.flatMap((error): ReadonlyArray<TLocalizedValidationError> => {
    if (!unmatched(error)) return [error];
    if (reported.has(error.instancePath)) return [];
    reported.add(error.instancePath);
    const allowed = selected
      .filter((other) => other.instancePath === error.instancePath && unmatched(other))
      .flatMap(allowedValues);
    return [{ ...error, keyword: "enum", params: { allowedValues: [...new Set(allowed)] } }];
  });
};

// Mirrors Pi's TypeBox conversion before validation, so the reported issues are the ones Pi rejected.
const validationIssues = (
  parameters: TSchema,
  args: JsonObject,
  context: IssueContext,
): ReadonlyArray<string> => {
  const candidate = structuredClone(args);
  Convert(parameters, candidate);
  const errors = selectedBranchErrors([...Errors(parameters, candidate)], context.schema);
  return [...new Set(errors.map((error) => issueText(error, args, context)))];
};

const clippedStrings = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return clipText(value, MAX_ECHO_STRING_CHARS);
  if (isJsonArray(value)) return value.map(clippedStrings);
  return isJsonRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clippedStrings(item)]))
    : value;
};

const EMPTY_ARGUMENTS_HINT =
  "No arguments were received; if you sent arguments, the tool-call JSON was malformed or truncated. Resend it as valid JSON.";

const invalidArgumentsError = (
  toolName: string,
  issues: ReadonlyArray<string>,
  args?: JsonObject,
  hints: ReadonlyArray<string> = [],
): Error => {
  const listed = issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => `- ${issue}`);
  const more = issues.length - listed.length;
  return new Error(
    [
      `[invalid_arguments] ${toolName} arguments are invalid:`,
      ...listed,
      ...(more > 0 ? [`- and ${more} more`] : []),
      ...(args
        ? [`Received: ${clipText(JSON.stringify(clippedStrings(args)), MAX_ECHO_CHARS)}`]
        : []),
      ...hints,
    ].join("\n"),
  );
};

export interface ToolArgumentPreparerOptions {
  /** Unknown keys named here get a "use <field>" hint when the field is accepted. */
  readonly aliases?: ToolFieldAliases;
  /** Rejects tool-specific shapes, after blank optionals are dropped and before validation. */
  readonly inspect?: (args: JsonObject) => void;
  /** Fields whose whitespace-only text, such as a literal `" "` to match, is kept and accepted. */
  readonly keepWhitespace?: ToolWhitespaceFields;
}

/**
 * Builds a Pi `prepareArguments` hook that drops blank optional fields and nulls their schemas
 * reject, then validates and coerces arguments with Pi's own validation, but reports allowed
 * values, unknown fields, and blank strings precisely and echoes only bounded arguments.
 * Model-facing schemas omit `pattern`, so nonblank required text is enforced here. The result is
 * checked against `parameters` with TypeBox, so it is the schema's `Static` type.
 * Pi parses malformed tool-call JSON as `{}` before this hook runs, so such a call fails here with
 * the schema's missing required fields rather than Pi's parse error, plus a hint to resend it.
 */
export const toolArgumentPreparer = <const S extends TSchema>(
  toolName: string,
  parameters: S,
  { aliases = {}, inspect, keepWhitespace = [] }: ToolArgumentPreparerOptions = {},
) => {
  const context: IssueContext = {
    toolName,
    schema: decodeSerializedSchema(JSON.stringify(parameters)),
    aliases,
  };
  const omitBlankOptionals = omitBlankOptionalArguments(parameters, keepWhitespace);
  const tool = { name: toolName, description: toolName, parameters };
  const validate = Option.liftThrowable((args: JsonObject) =>
    decodeJson(
      validateToolArguments(tool, {
        type: "toolCall",
        id: "prepare-arguments",
        name: toolName,
        arguments: args,
      }),
    ),
  );
  // The schema's own check, so the hook's result is exactly what Pi declares for `parameters`.
  const isArgs = (value: unknown): value is Static<S> => Check(parameters, value);
  const prepare = (received: JsonObject): JsonValue => {
    const args = omitBlankOptionals(received);
    inspect?.(args);
    // Pi substitutes `{}` for malformed tool-call JSON, so an empty call may have lost its arguments.
    const hints = Object.keys(received).length === 0 ? [EMPTY_ARGUMENTS_HINT] : [];
    const validated = Option.getOrThrowWith(Option.flatten(validate(args)), () => {
      const issues = validationIssues(parameters, args, context);
      return invalidArgumentsError(
        toolName,
        issues.length > 0 ? issues : ["arguments did not match the tool schema."],
        args,
        hints,
      );
    });
    const blank = blankStringPath(validated, keepWhitespace);
    if (blank !== undefined)
      throw invalidArgumentsError(toolName, [`${blank} must contain non-whitespace text.`]);
    return validated;
  };
  return Fn.flow(
    decodeArgumentsObject,
    Option.getOrThrowWith(() =>
      invalidArgumentsError(toolName, ["arguments must be a JSON object."]),
    ),
    prepare,
    Option.liftPredicate(isArgs),
    Option.getOrThrowWith(() =>
      invalidArgumentsError(toolName, ["arguments did not match the tool schema."]),
    ),
  );
};
