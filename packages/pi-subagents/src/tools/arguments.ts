import { validateToolArguments } from "@earendil-works/pi-ai";
import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { clipText, isJsonObject, type JsonObject, type JsonValue } from "pi-cosmic-core";
import type { TSchema } from "typebox";
import type { TLocalizedValidationError } from "typebox/error";
import { Convert, Errors } from "typebox/value";

const MAX_REPORTED_ISSUES = 8;
const MAX_ECHO_CHARS = 600;
const MAX_ECHO_STRING_CHARS = 80;
const MAX_REPORTED_VALUE_CHARS = 60;

// Parents trained on other harnesses send these field names; name the replacement instead of
// only rejecting the key.
const FIELD_ALIASES: ReadonlyMap<string, string> = new Map([
  ["prompt", "task"],
  ["description", "name"],
  ["subagent_type", "profile"],
  ["subagentType", "profile"],
  ["agent", "profile"],
  ["agent_type", "profile"],
  ["workspace", "isolation"],
  ["worktree", "isolation"],
  ["workspaceMode", "isolation"],
  ["writerWorkspaceMode", "isolation"],
]);

export const decodeArgumentsObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson),
);
const decodeSerializedSchema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json));
const decodeJson = Schema.decodeUnknownOption(Schema.MutableJson);

const isJsonArray = (value: Schema.Json | undefined): value is Schema.JsonArray =>
  Array.isArray(value);
const isJsonRecord = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Array.isArray(value);

const childEntries = (
  value: Schema.Json,
  path: string,
): ReadonlyArray<readonly [string, Schema.Json]> => {
  if (isJsonArray(value)) return value.map((item, index) => [`${path}[${index}]`, item] as const);
  return isJsonRecord(value)
    ? Object.entries(value).map(([key, item]) => [path ? `${path}.${key}` : key, item] as const)
    : [];
};

/** Location of the first string that is empty or only whitespace, such as `agents[0].task`. */
export const blankStringPath = (value: Schema.Json, path = ""): string | undefined => {
  if (Predicate.isString(value)) return value.trim() ? undefined : path || "value";
  for (const [childPath, child] of childEntries(value, path)) {
    const blank = blankStringPath(child, childPath);
    if (blank !== undefined) return blank;
  }
  return undefined;
};

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

/** The accepted field an unknown key most likely meant, such as `task` for `prompt`. */
export const replacementField = (
  key: string,
  accepted: ReadonlyArray<string>,
): string | undefined => {
  const camel = key.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());
  return [
    FIELD_ALIASES.get(key) ?? FIELD_ALIASES.get(camel),
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
): string => {
  const named = keys.map((key) => {
    const replacement = replacementField(key, accepted);
    return replacement ? `"${key}" (use "${replacement}")` : `"${key}"`;
  });
  const fields =
    accepted.length > 0 ? `accepted fields: ${accepted.join(", ")}` : "it takes no fields";
  return `${subject} does not accept ${named.join(", ")}; ${fields}.`;
};

const issueText = (
  error: TLocalizedValidationError,
  args: Schema.Json,
  schema: Schema.Json,
  toolName: string,
): string => {
  const subject = displayPath(error.instancePath, toolName);
  if (error.keyword === "additionalProperties")
    return unknownFieldsIssue(
      subject,
      error.params.additionalProperties,
      acceptedFields(valueAt(schema, error.schemaPath)),
    );
  if (error.keyword === "enum")
    return `${subject} must be one of ${error.params.allowedValues.map(String).join(", ")}; received ${reportedValue(valueAt(args, error.instancePath))}.`;
  if (error.keyword === "required")
    return `${error.params.requiredProperties
      .map((field) => displayPath(`${error.instancePath}/${field}`, toolName))
      .join(", ")} is required.`;
  return `${subject} ${error.message}.`;
};

const withoutOptionalNulls = (value: JsonValue, schema: Schema.Json | undefined): void => {
  if (!isJsonRecord(schema)) return;
  if (Array.isArray(value)) {
    for (const item of value) withoutOptionalNulls(item, schema.items);
    return;
  }
  const properties = schema.properties;
  if (!isJsonObject(value) || !isJsonRecord(properties)) return;
  const required = schema.required;
  for (const [key, propertySchema] of Object.entries(properties)) {
    const item = value[key];
    if (item === null && !(isJsonArray(required) && required.includes(key))) delete value[key];
    else if (item !== undefined) withoutOptionalNulls(item, propertySchema);
  }
};

// Mirrors Pi's coercion before validation, so the reported issues are the ones Pi rejected.
const validationIssues = (
  parameters: TSchema,
  schema: Schema.Json,
  args: JsonObject,
  toolName: string,
): ReadonlyArray<string> => {
  const candidate = structuredClone(args);
  withoutOptionalNulls(candidate, schema);
  Convert(parameters, candidate);
  return [
    ...new Set(
      Errors(parameters, candidate).map((error) => issueText(error, args, schema, toolName)),
    ),
  ];
};

const clippedStrings = (value: Schema.Json): Schema.Json => {
  if (Predicate.isString(value)) return clipText(value, MAX_ECHO_STRING_CHARS);
  if (isJsonArray(value)) return value.map(clippedStrings);
  return isJsonRecord(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clippedStrings(item)]))
    : value;
};

const invalidArgumentsError = (
  toolName: string,
  issues: ReadonlyArray<string>,
  args?: JsonObject,
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
    ].join("\n"),
  );
};

/**
 * Builds a Pi `prepareArguments` hook that validates and coerces arguments as Pi does, but
 * reports allowed values, unknown fields, and blank strings precisely and echoes only bounded
 * arguments. Model-facing schemas omit `pattern`, so nonblank text is enforced here. `isArgs`
 * is the schema's own check, and `inspect` rejects tool-specific shapes before validation.
 */
export const toolArgumentPreparer = <Args>(
  toolName: string,
  parameters: TSchema,
  isArgs: (value: unknown) => value is Args,
  inspect?: (args: JsonObject) => void,
) => {
  const schema = decodeSerializedSchema(JSON.stringify(parameters));
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
  const prepare = (args: JsonObject): Args => {
    inspect?.(args);
    const validated = Option.getOrThrowWith(Option.flatten(validate(args)), () => {
      const issues = validationIssues(parameters, schema, args, toolName);
      return invalidArgumentsError(
        toolName,
        issues.length > 0 ? issues : ["arguments did not match the tool schema."],
        args,
      );
    });
    const blank = blankStringPath(validated);
    if (blank !== undefined)
      throw invalidArgumentsError(toolName, [`${blank} must contain non-whitespace text.`]);
    if (!isArgs(validated))
      throw invalidArgumentsError(toolName, ["arguments did not match the tool schema."], args);
    return validated;
  };
  return flow(
    decodeArgumentsObject,
    Option.getOrThrowWith(() =>
      invalidArgumentsError(toolName, ["arguments must be a JSON object."]),
    ),
    prepare,
  );
};
