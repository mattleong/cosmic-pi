import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";

/**
 * The JSON Schema subset scripts write, for `agent()` results and workflow args: Draft 2020-12
 * without references, bounded in size and depth, with every regex compiling in Unicode mode.
 * Schemas describe one value; they are not data dumps.
 */
export const JSON_SCHEMA_MAX_CHARS = 16 * 1024;
export const JSON_SCHEMA_MAX_DEPTH = 16;

export class InvalidJsonSchemaError extends Schema.TaggedError<InvalidJsonSchemaError>()(
  "InvalidJsonSchemaError",
  { message: Schema.String },
) {}

/** What a schema describes, as its errors name it. */
export type JsonSchemaSubject = "Result" | "Args";

export type JsonRecord = Readonly<Record<string, Schema.Json>>;

export const decodeJsonRecord = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.Json),
);
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

/** JSON text that survives terminal sanitization: C1 controls and line separators are escaped. */
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
  /** Why the first unusable regex in the node or a nested subschema can't be compiled. */
  readonly invalidPattern: string | undefined;
  /** The first draft-07 form the root's 2020-12 import skips, with its replacement. */
  readonly legacy: string | undefined;
}

const LEAF: SchemaFacts = {
  depth: 0,
  rejected: undefined,
  strictSafe: true,
  invalidPattern: undefined,
  legacy: undefined,
};
/**
 * Keywords whose value is one subschema. Pi's tool validation also reads draft-07 `items` lists,
 * `additionalItems` and `dependencies`, so their subschemas are walked too.
 */
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
/** Keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
/** Keywords whose value maps names to subschemas. */
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
  legacy: facts.find((fact) => fact.legacy !== undefined)?.legacy,
});

const children = (key: string, value: Schema.Json): ReadonlyArray<Schema.Json> => {
  if (SUBSCHEMA_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => [value]);
  if (SUBSCHEMA_LIST_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => []);
  if (SUBSCHEMA_MAP_KEYWORDS.has(key))
    return Option.match(decodeJsonRecord(value), { onNone: () => [], onSome: Object.values });
  return [];
};

const isScalarType = Schema.is(Schema.Literals(["string", "number", "integer", "boolean", "null"]));
const isString = Schema.is(Schema.String);
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const isSchemaNode = (value: Schema.Json | undefined): boolean =>
  Option.isSome(decodeJsonRecord(value));

/**
 * Whether strict sampling keeps this node's meaning. Strict conversion closes every object over
 * its listed properties, so an open object could only be sampled as `{}`; providers also reject
 * untyped nodes and arrays without an item schema. Nested nodes are checked by {@link inspect}.
 */
const isStrictNode = (node: JsonRecord): boolean => {
  if (!Object.keys(node).every((key) => STRICT_KEYWORDS.has(key))) return false;
  const objectKeywords =
    node.properties !== undefined ||
    node.required !== undefined ||
    node.additionalProperties !== undefined;
  switch (node.type) {
    case "object":
      return (
        node.additionalProperties === false &&
        node.items === undefined &&
        Option.exists(decodeJsonRecord(node.properties), (properties) =>
          Object.values(properties).every(isSchemaNode),
        )
      );
    case "array":
      return !objectKeywords && isSchemaNode(node.items);
    case undefined:
      return (
        !objectKeywords &&
        node.items === undefined &&
        (node.enum !== undefined || node.const !== undefined)
      );
    default:
      return !objectKeywords && node.items === undefined && isScalarType(node.type);
  }
};

const PATTERN_DISPLAY_MAX_CHARS = 120;

/**
 * Why a regex source is unusable, if it is, after the subject's "schema". Pi's tool validation
 * compiles every `pattern` and `patternProperties` key in Unicode mode and fails every call when
 * one doesn't compile, so the root checks the same syntax. Compiling only parses the source; no
 * input is ever evaluated.
 */
const patternProblem = (source: Schema.Json): string | undefined => {
  if (!isString(source)) return "patterns must be strings.";
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

/** Regex sources a node itself declares: its `pattern` and its `patternProperties` keys. */
const ownPatterns = (node: JsonRecord): ReadonlyArray<Schema.Json> => [
  ...(node.pattern === undefined ? [] : [node.pattern]),
  ...Option.match(decodeJsonRecord(node.patternProperties), {
    onNone: () => [],
    onSome: (patterns) => Object.keys(patterns),
  }),
];

/**
 * A draft-07 form the node uses that Effect's 2020-12 importer skips as an unknown keyword, so the
 * root would never check it: an `items` list, `additionalItems` or `dependencies`.
 */
const legacyForm = (node: JsonRecord): string | undefined => {
  if (Option.isSome(decodeArray(node.items)))
    return "a draft-07 `items` list; use `prefixItems` for tuples";
  if (node.additionalItems !== undefined)
    return "draft-07 `additionalItems`; use `items` after `prefixItems`";
  if (node.dependencies !== undefined) return "draft-07 `dependencies`";
  return undefined;
};

/** Walks nested subschemas (not data such as `enum` members), collecting bounds and keyword facts. */
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
    legacy: legacyForm(record.value),
  };
  const nested = combine(
    Object.entries(record.value).flatMap(([key, value]) => children(key, value).map(inspect)),
  );
  return { ...combine([own, nested]), depth: nested.depth + 1 };
}

/**
 * The root skips keywords it can't evaluate safely or at all, such as `pattern` and `format`, so
 * `oneOf` branches that differ only by one of them would all match and exclude each other. Every
 * `oneOf` therefore validates as `anyOf` in the root, which only admits more.
 */
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

/** Keywords that hold a number to an integral value, alongside any `multipleOf` the node has. */
const integralConstraint = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
  node.multipleOf === undefined
    ? { multipleOf: 1 }
    : { allOf: [...Option.getOrElse(decodeArray(node.allOf), () => []), { multipleOf: 1 }] };

/**
 * Effect imports `integer` as a safe integer, but JSON Schema and Pi's tool validation admit any
 * integral number. The root checks integers as numbers that are multiples of 1, which holds at
 * any magnitude.
 */
const widenInteger = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema => {
  if (node.type === "integer") return { ...node, type: "number", ...integralConstraint(node) };
  const types = Option.getOrElse(decodeStrings(node.type), (): ReadonlyArray<string> => []);
  if (!types.includes("integer")) return node;
  // `number` already admits every integer.
  if (types.includes("number"))
    return { ...node, type: types.filter((type) => type !== "integer") };
  return {
    ...node,
    type: types.map((type) => (type === "integer" ? "number" : type)),
    ...integralConstraint(node),
  };
};

/** Rewrites each node before Effect imports it where Effect would reject values the schema admits. */
const importNode = (node: JsonSchema.JsonSchema): JsonSchema.JsonSchema =>
  widenInteger(relaxOneOf(node));

/** A schema the subset accepts, before it is imported. */
export interface CheckedJsonSchema {
  readonly root: JsonRecord;
  /** The schema's canonical JSON, whose digest identifies it. */
  readonly source: string;
  /**
   * Providers' strict tool sampling keeps the schema's meaning: every node is typed (or a pure
   * enum/const), objects are closed over listed properties, and arrays have an item schema.
   */
  readonly strictSafe: boolean;
}

/**
 * Checks a script-authored schema against the subset: a JSON Schema object within the size and
 * depth bounds, without references, whose every regex compiles in Unicode mode. An args schema
 * also can't use the draft-07 forms the root's import skips; a result schema may, since Pi's
 * tool validation still enforces them for local children.
 */
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
    if (subject === "Args" && facts.legacy !== undefined)
      return yield* invalid(`${subject} schemas can't use ${facts.legacy}.`);
    return { root: root.value, source, strictSafe: facts.strictSafe };
  });

/**
 * A validator for the values `schema` accepts, at any root. It may admit more than the schema:
 * patterns and formats are not evaluated, so the root never runs a script-authored regex, and
 * `oneOf` validates as `anyOf`. Excess keys fail only where an object is closed.
 */
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
      // Safety: the importer yields a JSON-only codec; parse options below reject excess keys.
      const codec = Schema.make<Schema.Codec<Schema.Json>>(imported.ast);
      const decodeValue = Schema.decodeUnknownEffect(codec);
      return (value: Schema.Json) =>
        decodeValue(value, { onExcessProperty: "error", errors: "all" });
    }),
  );
