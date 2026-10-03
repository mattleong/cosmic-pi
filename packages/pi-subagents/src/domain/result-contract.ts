import * as Effect from "effect/Effect";
import * as JsonSchema from "effect/JsonSchema";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaRepresentation from "effect/SchemaRepresentation";
import { sha256Text } from "pi-cosmic-core";

/** Result schemas describe one deliverable; they are not data dumps. */
export const RESULT_SCHEMA_MAX_CHARS = 16 * 1024;
export const RESULT_SCHEMA_MAX_DEPTH = 16;
/** Canonical JSON of an accepted result stays well under report clipping. */
export const RESULT_VALUE_MAX_CHARS = 32 * 1024;
/** Property that carries a non-object result inside the object-rooted tool parameters. */
export const WRAPPED_RESULT_PROPERTY = "value";

export class InvalidResultSchemaError extends Schema.TaggedError<InvalidResultSchemaError>()(
  "InvalidResultSchemaError",
  { message: Schema.String },
) {}

export class ResultContractViolation extends Schema.TaggedError<ResultContractViolation>()(
  "ResultContractViolation",
  { message: Schema.String },
) {}

type JsonRecord = Readonly<Record<string, Schema.Json>>;

export interface ResultContract {
  /** Object-rooted JSON Schema for the result tool's parameters. */
  readonly parameters: JsonRecord;
  /** True when a non-object schema was wrapped under {@link WRAPPED_RESULT_PROPERTY}. */
  readonly wrapped: boolean;
  /**
   * Providers' strict tool sampling keeps the schema's meaning: every node is typed (or a pure
   * enum/const), objects are closed over listed properties, and arrays have an item schema.
   */
  readonly strictSafe: boolean;
  /** Stable identity of the schema, for resume journals. */
  readonly digest: string;
  /**
   * Validates submitted tool arguments and returns the unwrapped result value. This is a safety
   * net that may admit more than the schema: patterns and formats are not evaluated (the root never
   * runs script-authored regexes), and `oneOf` validates as `anyOf`. A Pi child's own tool
   * validation enforces them; for other backends they are advisory schema text.
   */
  readonly decode: (submitted: Schema.Json) => Effect.Effect<Schema.Json, ResultContractViolation>;
}

const decodeRecord = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));
const decodeArray = Schema.decodeUnknownOption(Schema.Array(Schema.Json));

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
}

const LEAF: SchemaFacts = {
  depth: 0,
  rejected: undefined,
  strictSafe: true,
  invalidPattern: undefined,
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
});

const children = (key: string, value: Schema.Json): ReadonlyArray<Schema.Json> => {
  if (SUBSCHEMA_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => [value]);
  if (SUBSCHEMA_LIST_KEYWORDS.has(key)) return Option.getOrElse(decodeArray(value), () => []);
  if (SUBSCHEMA_MAP_KEYWORDS.has(key))
    return Option.match(decodeRecord(value), { onNone: () => [], onSome: Object.values });
  return [];
};

const isScalarType = Schema.is(Schema.Literals(["string", "number", "integer", "boolean", "null"]));
const isString = Schema.is(Schema.String);
const decodeStrings = Schema.decodeUnknownOption(Schema.Array(Schema.String));
const isSchemaNode = (value: Schema.Json | undefined): boolean =>
  Option.isSome(decodeRecord(value));

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
        Option.exists(decodeRecord(node.properties), (properties) =>
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
 * Why a regex source is unusable, if it is. Pi's tool validation compiles every `pattern` and
 * `patternProperties` key in Unicode mode and fails every call when one doesn't compile, so the
 * root checks the same syntax. Compiling only parses the source; no input is ever evaluated.
 */
const patternProblem = (source: Schema.Json): string | undefined => {
  if (!isString(source)) return "Result schema patterns must be strings.";
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
        `Result schema pattern \`${shown}\` must be valid with the ECMAScript Unicode (\`u\`) flag: ${reason.split(": ").at(-1) ?? reason}.`,
    },
  );
};

/** Regex sources a node itself declares: its `pattern` and its `patternProperties` keys. */
const ownPatterns = (node: JsonRecord): ReadonlyArray<Schema.Json> => [
  ...(node.pattern === undefined ? [] : [node.pattern]),
  ...Option.match(decodeRecord(node.patternProperties), {
    onNone: () => [],
    onSome: (patterns) => Object.keys(patterns),
  }),
];

/** Walks nested subschemas (not data such as `enum` members), collecting bounds and keyword facts. */
function inspect(schema: Schema.Json): SchemaFacts {
  const record = decodeRecord(schema);
  if (Option.isNone(record)) return LEAF;
  const own: SchemaFacts = {
    depth: 0,
    rejected: Object.keys(record.value).find((key) => REJECTED_KEYWORDS.has(key)),
    strictSafe: isStrictNode(record.value),
    invalidPattern: ownPatterns(record.value)
      .map(patternProblem)
      .find((problem) => problem !== undefined),
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

const isObjectRooted = (schema: JsonRecord): boolean =>
  schema.type === "object" &&
  schema.properties !== undefined &&
  Option.isSome(decodeRecord(schema.properties));

/** JSON text that survives terminal sanitization: C1 controls and line separators are escaped. */
export const canonicalResultJson = (value: Schema.Json): string =>
  JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

const invalid = (message: string) => new InvalidResultSchemaError({ message });

/** The schema a result value itself must match, before any wrapping for the tool parameters. */
export const resultValueSchema = (contract: ResultContract): Schema.Json =>
  contract.wrapped
    ? Option.getOrElse(
        Option.flatMap(decodeRecord(contract.parameters.properties), (properties) =>
          Option.fromNullishOr(properties[WRAPPED_RESULT_PROPERTY]),
        ),
        () => ({}),
      )
    : contract.parameters;

/** Validates an unwrapped result value, such as a JSON report, and returns it. */
export const decodeResultValue = (
  contract: ResultContract,
  value: Schema.Json,
): Effect.Effect<Schema.Json, ResultContractViolation> =>
  contract.decode(contract.wrapped ? { [WRAPPED_RESULT_PROPERTY]: value } : value);

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const FENCED_BLOCK = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/giu;

/** JSON a text answer may carry: the whole text, else its fenced blocks, last first. */
const resultJsonCandidates = (text: string): ReadonlyArray<Schema.Json> => {
  const whole = decodeJsonText(text.trim());
  if (Option.isSome(whole)) return [whole.value];
  return [...text.matchAll(FENCED_BLOCK)]
    .reverse()
    .flatMap((match) => Option.toArray(decodeJsonText((match[1] ?? "").trim())));
};

/**
 * Validates a result written as text. The value form is tried first; a wrapped contract also
 * accepts its tool-argument form. The first candidate's problems explain a rejection.
 */
export const decodeResultText = (
  contract: ResultContract,
  text: string,
): Effect.Effect<Schema.Json, ResultContractViolation> => {
  const attempts = resultJsonCandidates(text).flatMap((candidate) =>
    contract.wrapped
      ? [decodeResultValue(contract, candidate), contract.decode(candidate)]
      : [contract.decode(candidate)],
  );
  const [first, ...rest] = attempts;
  if (first === undefined)
    return Effect.fail(new ResultContractViolation({ message: "The result is not valid JSON." }));
  return rest.reduce(
    (previous, attempt) =>
      previous.pipe(Effect.catch((error) => attempt.pipe(Effect.mapError(() => error)))),
    first,
  );
};

/**
 * Compiles an agent's JSON Schema (Draft 2020-12 subset supported by Effect's importer) into a
 * result contract. The tool parameters keep the schema as written, `pattern` included; the root's
 * validator ignores patterns so a script-authored regex can never block the root's event loop, but
 * every pattern must still compile in Unicode mode, as Pi's tool validation requires.
 */
export const compileResultContract = (
  schema: Schema.Json,
): Effect.Effect<ResultContract, InvalidResultSchemaError> =>
  Effect.gen(function* () {
    const source = canonicalResultJson(schema);
    if (source.length > RESULT_SCHEMA_MAX_CHARS)
      return yield* invalid(`Result schemas are limited to ${RESULT_SCHEMA_MAX_CHARS} characters.`);
    const root = decodeRecord(schema);
    if (Option.isNone(root)) return yield* invalid("A result schema must be a JSON Schema object.");
    const facts = inspect(schema);
    if (facts.depth > RESULT_SCHEMA_MAX_DEPTH)
      return yield* invalid(
        `Result schemas are limited to ${RESULT_SCHEMA_MAX_DEPTH} levels of nesting.`,
      );
    if (facts.rejected !== undefined)
      return yield* invalid(
        `Result schemas can't use \`${facts.rejected}\`; inline the definition instead.`,
      );
    if (facts.invalidPattern !== undefined) return yield* invalid(facts.invalidPattern);
    const wrapped = !isObjectRooted(root.value);
    const parameters: JsonRecord = wrapped
      ? {
          type: "object",
          properties: { [WRAPPED_RESULT_PROPERTY]: root.value },
          required: [WRAPPED_RESULT_PROPERTY],
          additionalProperties: false,
        }
      : root.value;
    const imported = yield* Effect.try({
      try: () =>
        SchemaRepresentation.fromJsonSchemaDocument(JsonSchema.fromSchemaDraft2020_12(parameters), {
          patterns: "ignore",
          onEnter: importNode,
        }),
      catch: (error) =>
        invalid(
          `Unsupported result schema: ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    // Safety: the importer yields a JSON-only codec; parse options below reject excess keys.
    const codec = Schema.make<Schema.Codec<Schema.Json>>(imported.ast);
    const decodeValue = Schema.decodeUnknownEffect(codec);
    const decode = (submitted: Schema.Json) =>
      decodeValue(submitted, { onExcessProperty: "error", errors: "all" }).pipe(
        Effect.mapError((error) => new ResultContractViolation({ message: error.message })),
        Effect.flatMap((value) => {
          if (!wrapped) return Effect.succeed(value);
          const record = decodeRecord(value);
          return Option.isSome(record) && WRAPPED_RESULT_PROPERTY in record.value
            ? Effect.succeed(record.value[WRAPPED_RESULT_PROPERTY] ?? null)
            : Effect.fail(
                new ResultContractViolation({ message: `Missing \`${WRAPPED_RESULT_PROPERTY}\`.` }),
              );
        }),
        Effect.filterOrFail(
          (value) => canonicalResultJson(value).length <= RESULT_VALUE_MAX_CHARS,
          () =>
            new ResultContractViolation({
              message: `Results are limited to ${RESULT_VALUE_MAX_CHARS} characters of JSON.`,
            }),
        ),
      );
    return {
      parameters,
      wrapped,
      strictSafe: facts.strictSafe,
      digest: sha256Text(source),
      decode,
    } satisfies ResultContract;
  });
