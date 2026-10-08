import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sha256Text } from "pi-cosmic-core";
import {
  canonicalJsonText,
  checkJsonSchema,
  decodeJsonRecord,
  importJsonSchema,
  type InvalidJsonSchemaError,
  type JsonRecord,
} from "./json-schema.ts";

/** Canonical JSON of an accepted result stays well under report clipping. */
export const RESULT_VALUE_MAX_CHARS = 32 * 1024;
/** Property that carries a non-object result inside the object-rooted tool parameters. */
export const WRAPPED_RESULT_PROPERTY = "value";

/** A result value's JSON text, as reports, journals and size bounds count it. */
export const canonicalResultJson = canonicalJsonText;

export class ResultContractViolation extends Schema.TaggedError<ResultContractViolation>()(
  "ResultContractViolation",
  { message: Schema.String },
) {}

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

const isObjectRooted = (schema: JsonRecord): boolean =>
  schema.type === "object" && Option.isSome(decodeJsonRecord(schema.properties));

/** The schema a result value itself must match, before any wrapping for the tool parameters. */
export const resultValueSchema = (contract: ResultContract): Schema.Json =>
  contract.wrapped
    ? Option.getOrElse(
        Option.flatMap(decodeJsonRecord(contract.parameters.properties), (properties) =>
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
): Effect.Effect<ResultContract, InvalidJsonSchemaError> =>
  Effect.gen(function* () {
    const { root, source, strictSafe } = yield* checkJsonSchema(schema, "Result");
    const wrapped = !isObjectRooted(root);
    const parameters: JsonRecord = wrapped
      ? {
          type: "object",
          properties: { [WRAPPED_RESULT_PROPERTY]: root },
          required: [WRAPPED_RESULT_PROPERTY],
          additionalProperties: false,
        }
      : root;
    const decodeValue = yield* importJsonSchema(parameters, "Result");
    const decode = (submitted: Schema.Json) =>
      decodeValue(submitted).pipe(
        Effect.mapError((error) => new ResultContractViolation({ message: error.message })),
        Effect.flatMap((value) => {
          if (!wrapped) return Effect.succeed(value);
          const record = decodeJsonRecord(value);
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
      strictSafe,
      digest: sha256Text(source),
      decode,
    } satisfies ResultContract;
  });
