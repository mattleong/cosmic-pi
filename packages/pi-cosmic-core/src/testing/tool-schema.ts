import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { isJsonObject, type JsonValue } from "../platform/json-document.ts";

// llama.cpp compiles tool schemas into grammars and rejects unanchored patterns; strict
// validators on other providers reject the remaining keywords. Enforce such constraints in
// argument preparation instead of the declared schema.
const NONPORTABLE_KEYWORDS = [
  "pattern",
  "patternProperties",
  "deprecated",
  "const",
  "allOf",
  "if",
  "then",
  "else",
  "not",
] as const;
const SCHEMA_KEYWORDS = ["items", "additionalProperties", "not", "if", "then", "else"] as const;
const SCHEMA_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;

const decodeSerializedSchema = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson));

const childSchemas = (
  node: { readonly [key: string]: JsonValue },
  path: string,
): ReadonlyArray<readonly [string, JsonValue]> => {
  const properties = node.properties;
  return [
    ...(isJsonObject(properties)
      ? Arr.map(
          Rec.toEntries<string, JsonValue>(properties),
          ([name, child]) => [`${path}.properties.${name}`, child] as const,
        )
      : []),
    ...Arr.flatMap(SCHEMA_KEYWORDS, (keyword) => {
      const child = node[keyword];
      return child === undefined ? [] : [[`${path}.${keyword}`, child] as const];
    }),
    ...Arr.flatMap(SCHEMA_LIST_KEYWORDS, (keyword) => {
      const list = node[keyword];
      return Arr.isArray(list)
        ? Arr.map(list, (child, index) => [`${path}.${keyword}[${index}]`, child] as const)
        : [];
    }),
  ];
};

const schemaProblems = (node: JsonValue, path: string): ReadonlyArray<string> => {
  if (!isJsonObject(node)) return [];
  const problems = Arr.flatMap(NONPORTABLE_KEYWORDS, (keyword) =>
    Rec.has<string, JsonValue>(node, keyword) ? [`${path}: ${keyword}`] : [],
  );
  const typedUnion =
    Rec.has<string, JsonValue>(node, "type") &&
    (Rec.has<string, JsonValue>(node, "anyOf") || Rec.has<string, JsonValue>(node, "oneOf"));
  return [
    ...problems,
    ...(typedUnion ? [`${path}: type with anyOf or oneOf`] : []),
    ...Arr.flatMap(childSchemas(node, path), ([childPath, child]) =>
      schemaProblems(child, childPath),
    ),
  ];
};

/**
 * Lists keywords in a model-facing tool parameter schema that some providers reject, as
 * `path: keyword` entries. Pi sends providers the schema's JSON serialization, so that is what
 * gets inspected.
 */
export const toolSchemaPortabilityProblems = Fn.flow(
  JSON.stringify,
  decodeSerializedSchema,
  (schema): ReadonlyArray<string> => schemaProblems(schema, "#"),
);
