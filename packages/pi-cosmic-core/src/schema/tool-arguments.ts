import { validateToolArguments } from "@earendil-works/pi-ai";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { compile, type ValidationError, type Validator } from "@earendil-works/pi-schema";
import type { Static, TSchema } from "typebox";
import { formats } from "@earendil-works/pi-schema/formats";
import { clipText } from "../display.ts";
import { isJsonObject, type JsonObject, type JsonValue } from "../platform/json-document.ts";
import { findOrUndefined } from "../array.ts";

const validators = new WeakMap<object, Validator>();

/** Check without coercion; retain the host's parameter inference for builders and literal schemas. */
export const checkToolArguments = <S extends object>(
  parameters: S,
  value: unknown,
): value is Static<S> => {
  let validator = validators.get(parameters);
  if (!validator) {
    validator = compile(parameters, { formats, unresolvedRefs: "reject" });
    validators.set(parameters, validator);
  }
  return validator.check(value);
};

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
  Arr.isArray(value);
const isJsonRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value);

/**
 * Dotted property paths, such as `contains` or `agents.name`, whose whitespace-only text is
 * meaningful and kept. Array items take their array's path. Empty strings are still dropped.
 */
export type ToolWhitespaceFields = ReadonlyArray<string>;

const fieldPath = (parent: string, key: string): string => (parent ? `${parent}.${key}` : key);

const isBlank = (value: JsonValue, keepsWhitespace: boolean): boolean =>
  Predicate.isString(value) && (keepsWhitespace ? value : Str.trim(value)).length === 0;

// Keep null when a standalone property schema cannot be compiled.
const compileSchema = Option.liftThrowable((schema: Schema.JsonObject) =>
  compile(schema, { formats }),
);

/**
 * Like Pi's coercion, a null is dropped only when the property schema rejects it
 * and is not a `$ref`, so a nullable field keeps its explicit null.
 */
const rejectsNull = (schema: Schema.JsonObject): boolean =>
  !Predicate.isString(schema.$ref) &&
  Option.exists(compileSchema(schema), (validator) => !validator.check(null));

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
  const required = Arr.isArray(schema.required) ? schema.required : [];
  return Rec.fromEntries(
    Arr.flatMap(Rec.toEntries(value), ([key, item]) => {
      const propertySchema = Rec.has<string, Schema.Json>(properties, key)
        ? properties[key]
        : undefined;
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
  if (Arr.isArray(value))
    return Arr.map(value, (item) => withoutBlankOptionals(item, schema.items, path, omission));
  return isJsonObject(value)
    ? withoutBlankOptionalProperties(value, schema, path, omission)
    : value;
};

/**
 * Builds a pure normalizer of decoded tool arguments for a pi-schema or JSON Schema parameter
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
    return Arr.map(value, (item, index) => [{ path: `${path}[${index}]`, field }, item] as const);
  return isJsonRecord(value)
    ? Arr.map(
        Rec.toEntries(value),
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
  Fn.pipe(
    pointer,
    Str.replace(/^#?\/?/u, ""),
    Str.split("/"),
    Arr.filter((segment) => segment.length > 0),
    Arr.map((segment) => Fn.pipe(segment, Str.replaceAll("~1", "/"), Str.replaceAll("~0", "~"))),
  );

const valueAt = (root: Schema.Json, pointer: string): Schema.Json | undefined =>
  Arr.reduce<string, Schema.Json | undefined>(pathSegments(pointer), root, (node, segment) => {
    if (node === undefined) return undefined;
    if (isJsonArray(node)) return node[Number(segment)];
    return isJsonRecord(node) ? node[segment] : undefined;
  });

const displayPath = (pointer: string, root: string): string =>
  Arr.reduce(pathSegments(pointer), root, (label, segment) => {
    if (/^\d+$/u.test(segment)) return `${label}[${segment}]`;
    return label === root ? segment : `${label}.${segment}`;
  });

const reportedValue = (value: Schema.Json | undefined): string =>
  value === undefined ? "nothing" : clipText(JSON.stringify(value), MAX_REPORTED_VALUE_CHARS);

const acceptedFields = (schema: Schema.Json | undefined): ReadonlyArray<string> => {
  const properties = isJsonRecord(schema) ? schema.properties : undefined;
  return isJsonRecord(properties) ? Rec.keys<string, Schema.Json>(properties) : [];
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
  // @effect-diagnostics-next-line preferEffectString:off -- Str.replace takes no replacer callback
  const camel = key.replace(/_([a-z])/gu, (_match, letter: string) => Str.toUpperCase(letter));
  const alias = findOrUndefined([key, camel], (name) => Rec.has(aliases, name));
  return findOrUndefined(
    [
      alias === undefined ? undefined : aliases[alias],
      camel,
      `${camel}s`,
      Fn.pipe(camel, Str.replace(/s$/u, "")),
    ],
    (candidate) => candidate !== undefined && candidate !== key && accepted.includes(candidate),
  );
};

const unknownFieldsIssue = (
  subject: string,
  keys: ReadonlyArray<string>,
  accepted: ReadonlyArray<string>,
  aliases: ToolFieldAliases,
): string => {
  const named = Arr.map(keys, (key) => {
    const replacement = replacementField(key, accepted, aliases);
    return replacement ? `"${key}" (use "${replacement}")` : `"${key}"`;
  });
  const fields =
    accepted.length > 0 ? `accepted fields: ${Arr.join(accepted, ", ")}` : "it takes no fields";
  return `${subject} does not accept ${Arr.join(named, ", ")}; ${fields}.`;
};

interface IssueContext {
  readonly toolName: string;
  readonly schema: Schema.Json;
  readonly aliases: ToolFieldAliases;
}

const enumValues = (schema: Schema.Json | undefined): ReadonlyArray<Schema.Json> | undefined =>
  !isJsonRecord(schema)
    ? undefined
    : isJsonArray(schema.enum)
      ? schema.enum
      : schema.const !== undefined
        ? [schema.const]
        : undefined;

/**
 * Only diagnostics use this projection. Select common enum/const discriminants before asking
 * pi-schema for errors, so a stray field cannot make its closest-branch heuristic blame a
 * different mode. Validation and coercion always use the original schema.
 */
const diagnosticSchema = (schema: Schema.Json, value: Schema.Json | undefined): Schema.Json => {
  if (!isJsonRecord(schema)) return schema;
  const fields = Rec.fromEntries(Rec.toEntries(schema));
  const items = schema.items;
  if (isJsonArray(schema.anyOf) && isJsonRecord(value)) {
    const branches = schema.anyOf;
    const keys = acceptedFields(branches[0]);
    for (const key of keys) {
      const tags = Arr.map(branches, (branch) =>
        isJsonRecord(branch) && isJsonRecord(branch.properties)
          ? enumValues(branch.properties[key])
          : undefined,
      );
      if (!Arr.every(tags, (tag) => tag !== undefined) || value[key] === undefined) continue;
      const tagValue = value[key];
      const selected = Arr.filter(
        branches,
        (_, index) => tagValue !== undefined && tags[index]?.includes(tagValue) === true,
      );
      if (selected.length === 0)
        return {
          type: "object",
          properties: { [key]: { enum: Arr.flatMap(tags, (tag) => tag ?? []) } },
        };
      if (selected.length < branches.length)
        return diagnosticSchema({ ...fields, anyOf: selected }, value);
    }
  }
  return {
    ...fields,
    ...(isJsonRecord(schema.properties) && {
      properties: Rec.map(schema.properties, (property, key) =>
        diagnosticSchema(property, isJsonRecord(value) ? value[key] : undefined),
      ),
    }),
    ...(isJsonArray(schema.anyOf) && {
      anyOf: Arr.map(schema.anyOf, (branch) => diagnosticSchema(branch, value)),
    }),
    ...(isJsonRecord(items) &&
      isJsonArray(value) && {
        prefixItems: Arr.map(value, (item) => diagnosticSchema(items, item)),
        items: false,
      }),
  };
};

/** Candidate schemas at an instance pointer, including selected union branches. */
const schemasAt = (
  schema: Schema.Json,
  segments: ReadonlyArray<string>,
): ReadonlyArray<Schema.Json> => {
  if (!isJsonRecord(schema)) return [];
  const alternatives = isJsonArray(schema.anyOf)
    ? Arr.flatMap(schema.anyOf, (branch) => schemasAt(branch, segments))
    : [];
  if (segments.length === 0) return [schema, ...alternatives];
  const [key = "", ...rest] = segments;
  const child = isJsonRecord(schema.properties)
    ? schema.properties[key]
    : isJsonArray(schema.prefixItems)
      ? schema.prefixItems[Number(key)]
      : schema.items;
  return [...(child === undefined ? [] : schemasAt(child, rest)), ...alternatives];
};

const issueText = (
  error: ValidationError,
  args: Schema.Json,
  { toolName, schema, aliases }: IssueContext,
): string => {
  const subject = displayPath(error.path, toolName);
  if (error.keyword === "additionalProperties") {
    const segments = pathSegments(error.path);
    const key = segments.at(-1) ?? "";
    const parent = segments.slice(0, -1);
    const accepted = [...new Set(Arr.flatMap(schemasAt(schema, parent), acceptedFields))];
    const parentPath = Fn.pipe(
      error.path,
      Str.slice(
        0,
        Option.getOrElse(Fn.pipe(error.path, Str.lastIndexOf("/")), () => 0),
      ),
    );
    return unknownFieldsIssue(displayPath(parentPath, toolName), [key], accepted, aliases);
  }
  if (error.keyword === "required") return `${subject} is required.`;
  if (error.keyword === "enum" || error.keyword === "const" || error.keyword === "anyOf")
    return `${subject} ${error.message}; received ${reportedValue(valueAt(args, error.path))}.`;
  return `${subject} ${error.message}.`;
};

const validationIssues = (
  parameters: TSchema,
  args: JsonObject,
  context: IssueContext,
): ReadonlyArray<string> => {
  const candidate = Option.getOrElse(
    decodeJson(
      compile(parameters, { formats, coerce: true, unresolvedRefs: "reject" }).coerce(args),
    ),
    () => args,
  );
  const schema = diagnosticSchema(context.schema, candidate);
  if (!isJsonRecord(schema)) return [];
  const errors = compile(schema, { formats, unresolvedRefs: "reject" }).errors(candidate);
  return [...new Set(Arr.map(errors, (error) => issueText(error, args, { ...context, schema })))];
};

const clippedStrings = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return clipText(value, MAX_ECHO_STRING_CHARS);
  if (isJsonArray(value)) return Arr.map(value, clippedStrings);
  return isJsonRecord(value)
    ? Rec.fromEntries(Arr.map(Rec.toEntries(value), ([key, item]) => [key, clippedStrings(item)]))
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
  const listed = Arr.map(issues.slice(0, MAX_REPORTED_ISSUES), (issue) => `- ${issue}`);
  const more = issues.length - listed.length;
  return new Error(
    Arr.join(
      [
        `[invalid_arguments] ${toolName} arguments are invalid:`,
        ...listed,
        ...(more > 0 ? [`- and ${more} more`] : []),
        ...(args
          ? [`Received: ${clipText(JSON.stringify(clippedStrings(args)), MAX_ECHO_CHARS)}`]
          : []),
        ...hints,
      ],
      "\n",
    ),
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
 * checked against `parameters` with pi-schema, so it is the schema's `Static` type.
 * Pi parses malformed tool-call JSON as `{}` before this hook runs, so such a call fails here with
 * the schema's missing required fields rather than Pi's parse error, plus a hint to resend it.
 */
export const toolArgumentPreparer = <const S extends object>(
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
  const isArgs = (value: unknown): value is Static<S> => checkToolArguments(parameters, value);
  const prepare = (received: JsonObject): JsonValue => {
    const args = omitBlankOptionals(received);
    inspect?.(args);
    // Pi substitutes `{}` for malformed tool-call JSON, so an empty call may have lost its arguments.
    const hints = Rec.keys<string, JsonValue>(received).length === 0 ? [EMPTY_ARGUMENTS_HINT] : [];
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
