import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

export const JSON_SCHEMA_MAX_CHARS = 16 * 1024;
export const JSON_SCHEMA_MAX_DEPTH = 16;

export class InvalidJsonSchemaError extends Schema.TaggedError<InvalidJsonSchemaError>()(
  "InvalidJsonSchemaError",
  { message: Schema.String },
) {}

export type JsonSchemaSubject = "Result" | "Args";

export type JsonRecord = Readonly<Record<string, Schema.Json>>;

export const decodeJsonRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Json),
);
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

export const canonicalJsonText = (value: Schema.Json): string =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const REJECTED_KEYWORDS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "$dynamicRef",
  "$anchor",
]);
const STRICT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "enum",
  "const",
  "title",
  "description",
  "additionalProperties",
]);

interface SchemaFacts {
  readonly depth: number;
  readonly rejected: string | undefined;
  readonly strictSafe: boolean;
  readonly invalidPattern: string | undefined;
  readonly draft07Form: string | undefined;
}

const LEAF: SchemaFacts = {
  depth: 0,
  rejected: undefined,
  strictSafe: true,
  invalidPattern: undefined,
  draft07Form: undefined,
};
const SUBSCHEMA_KEYWORDS = new Set([
  "items",
  "additionalItems",
  "additionalProperties",
  "not",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
]);
const SUBSCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
]);

const combine = (facts: ReadonlyArray<SchemaFacts>): SchemaFacts => ({
  depth: Math.max(0, ...facts.map((fact) => fact.depth)),
  rejected: facts.find((fact) => fact.rejected !== undefined)?.rejected,
  strictSafe: facts.every((fact) => fact.strictSafe),
  invalidPattern: facts.find((fact) => fact.invalidPattern !== undefined)?.invalidPattern,
  draft07Form: facts.find((fact) => fact.draft07Form !== undefined)?.draft07Form,
});

const children = (key: string, value: Schema.Json): ReadonlyArray<Schema.Json> => {
  if (SUBSCHEMA_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => [value]);
  if (SUBSCHEMA_LIST_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => []);
  if (SUBSCHEMA_MAP_KEYWORDS.has(key))
    return Option.match(decodeJsonRecord(value), { onNone: () => [], onSome: Object.values });
  return [];
};

const isScalarType = Schema.is(Schema.Literals(["string", "number", "integer", "boolean", "null"]));
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const isSchemaNode = (value: Schema.Json | undefined): boolean =>
  Option.isSome(decodeJsonRecord(value));

const isStrictObjectNode = (node: JsonRecord): boolean =>
  node.additionalProperties === false &&
  node.items === undefined &&
  Option.exists(decodeJsonRecord(node.properties), (properties) =>
    Object.values(properties).every(isSchemaNode),
  );

const isStrictNode = (node: JsonRecord): boolean => {
  if (!Object.keys(node).every((key) => STRICT_KEYWORDS.has(key))) return false;
  if (node.type === "object") return isStrictObjectNode(node);
  const objectKeywords =
    node.properties !== undefined ||
    node.required !== undefined ||
    node.additionalProperties !== undefined;
  if (objectKeywords) return false;
  if (node.type === "array") return isSchemaNode(node.items);
  if (node.items !== undefined) return false;
  return node.type === undefined
    ? node.enum !== undefined || node.const !== undefined
    : isScalarType(node.type);
};

const PATTERN_DISPLAY_MAX_CHARS = 120;

const patternProblem = (source: Schema.Json): string | undefined => {
  if (!Predicate.isString(source)) return "patterns must be strings.";
  const shown =
    source.length > PATTERN_DISPLAY_MAX_CHARS
      ? `${source.slice(0, PATTERN_DISPLAY_MAX_CHARS - 1)}…`
      : source;
  return Result.match(
    Result.try({
      try: () => new RegExp(source, "u"),
      catch: (error) => (error instanceof Error ? error.message : String(error)),
    }),
    {
      onSuccess: () => undefined,
      onFailure: (reason) =>
        `pattern \`${shown}\` must be valid with the ECMAScript Unicode (\`u\`) flag: ${reason.split(": ").at(-1) ?? reason}.`,
    },
  );
};

const ownPatterns = (node: JsonRecord): ReadonlyArray<Schema.Json> => [
  ...(node.pattern === undefined ? [] : [node.pattern]),
  ...Option.match(decodeJsonRecord(node.patternProperties), {
    onNone: () => [],
    onSome: (patterns) => Object.keys(patterns),
  }),
];

const findDraft07Form = (node: JsonRecord): string | undefined => {
  if (Option.isSome(decodeArray(node.items)))
    return "a draft-07 `items` list; use `prefixItems` for tuples";
  if (node.additionalItems !== undefined)
    return "draft-07 `additionalItems`; use `items` after `prefixItems`";
  if (node.dependencies !== undefined) return "draft-07 `dependencies`";
  return undefined;
};

function inspect(schema: Schema.Json): SchemaFacts {
  const record = decodeJsonRecord(schema);
  if (Option.isNone(record)) return LEAF;
  const own: SchemaFacts = {
    depth: 0,
    rejected: Object.keys(record.value).find((key) => REJECTED_KEYWORDS.has(key)),
    strictSafe: isStrictNode(record.value),
    invalidPattern: ownPatterns(record.value)
      .map(patternProblem)
      .find((problem) => problem !== undefined),
    draft07Form: findDraft07Form(record.value),
  };
  const nested = combine(
    Object.entries(record.value).flatMap(([key, value]) => children(key, value).map(inspect)),
  );
  return { ...combine([own, nested]), depth: nested.depth + 1 };
}

const relaxOneOf = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (Option.isNone(decodeArray(node.oneOf))) return node;
  const { oneOf, ...rest } = node;
  return rest.anyOf === undefined
    ? { ...rest, anyOf: oneOf }
    : {
        ...rest,
        allOf: [...Option.getOrElse(decodeArray(rest.allOf), () => []), { anyOf: oneOf }],
      };
};

const integralConstraint = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
  node.multipleOf === undefined
    ? { multipleOf: 1 }
    : { allOf: [...Option.getOrElse(decodeArray(node.allOf), () => []), { multipleOf: 1 }] };

const widenInteger = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (node.type === "integer") return { ...node, type: "number", ...integralConstraint(node) };
  const types = Option.getOrElse(decodeStrings(node.type), (): ReadonlyArray<string> => []);
  if (!types.includes("integer")) return node;
  if (types.includes("number"))
    return { ...node, type: types.filter((type) => type !== "integer") };
  return {
    ...node,
    type: types.map((type) => (type === "integer" ? "number" : type)),
    ...integralConstraint(node),
  };
};

const importNode = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
  widenInteger(relaxOneOf(node));

export interface CheckedJsonSchema {
  readonly root: JsonRecord;
  readonly source: string;
  readonly strictSafe: boolean;
}

export const checkJsonSchema = (
  schema: Schema.Json,
  subject: JsonSchemaSubject,
): Effect.Effect<CheckedJsonSchema, InvalidJsonSchemaError> =>
  Effect.gen(function* () {
    const invalid = (message: string) => new InvalidJsonSchemaError({ message });
    const source = canonicalJsonText(schema);
    if (source.length > JSON_SCHEMA_MAX_CHARS)
      return yield* invalid(
        `${subject} schemas are limited to ${JSON_SCHEMA_MAX_CHARS} characters.`,
      );
    const root = decodeJsonRecord(schema);
    if (Option.isNone(root))
      return yield* invalid(`${subject} schemas must be JSON Schema objects.`);
    const facts = inspect(schema);
    if (facts.depth > JSON_SCHEMA_MAX_DEPTH)
      return yield* invalid(
        `${subject} schemas are limited to ${JSON_SCHEMA_MAX_DEPTH} levels of nesting.`,
      );
    if (facts.rejected !== undefined)
      return yield* invalid(
        `${subject} schemas can't use \`${facts.rejected}\`; inline the definition instead.`,
      );
    if (facts.invalidPattern !== undefined)
      return yield* invalid(`${subject} schema ${facts.invalidPattern}`);
    if (subject === "Args" && facts.draft07Form !== undefined)
      return yield* invalid(`${subject} schemas can't use ${facts.draft07Form}.`);
    return { root: root.value, source, strictSafe: facts.strictSafe };
  });

export const importJsonSchema = (
  schema: JsonRecord,
  subject: JsonSchemaSubject,
): Effect.Effect<
  (value: Schema.Json) => Effect.Effect<Schema.Json, Schema.SchemaError>,
  InvalidJsonSchemaError
> =>
  Effect.try({
    try: () =>
      SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(schema), {
        patterns: "ignore",
        onEnter: importNode,
      }),
    catch: (error) =>
      new InvalidJsonSchemaError({
        message: `Unsupported ${subject.toLowerCase()} schema: ${error instanceof Error ? error.message : String(error)}`,
      }),
  }).pipe(
    Effect.map((imported) => {
      const codec = Schema.make<Schema.Codec<Schema.Json>>(imported.ast);
      const decodeValue = Schema.decodeUnknownEffect(codec);
      return (value: Schema.Json) =>
        decodeValue(value, { onExcessProperty: "error", errors: "all" });
    }),
  );
