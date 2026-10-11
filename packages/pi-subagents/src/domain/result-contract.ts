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

export const RESULT_VALUE_MAX_CHARS = 32 * 1024;
export const WRAPPED_RESULT_PROPERTY = "value";

export const canonicalResultJson = canonicalJsonText;

export class ResultContractViolation extends Schema.TaggedError<ResultContractViolation>()(
  "ResultContractViolation",
  { message: Schema.String },
) {}

export interface ResultContract {
  readonly parameters: JsonRecord;
  readonly wrapped: boolean;
  readonly strictSafe: boolean;
  readonly digest: string;
  readonly decode: (submitted: Schema.Json) => Effect.Effect<Schema.Json, ResultContractViolation>;
}

const isObjectRooted = (schema: JsonRecord): boolean =>
  schema.type === "object" && Option.isSome(decodeJsonRecord(schema.properties));

export const resultValueSchema = (contract: ResultContract): Schema.Json =>
  contract.wrapped
    ? Option.getOrElse(
        Option.flatMap(decodeJsonRecord(contract.parameters.properties), (properties) =>
          Option.fromNullishOr(properties[WRAPPED_RESULT_PROPERTY]),
        ),
        () => ({}),
      )
    : contract.parameters;

export const decodeResultValue = (
  contract: ResultContract,
  value: Schema.Json,
): Effect.Effect<Schema.Json, ResultContractViolation> =>
  contract.decode(contract.wrapped ? { [WRAPPED_RESULT_PROPERTY]: value } : value);

const decodeJsonText = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
const FENCED_BLOCK = /```[a-z]*[ \t]*\r?\n([\s\S]*?)```/giu;

const resultJsonCandidates = (text: string): ReadonlyArray<Schema.Json> => {
  const whole = decodeJsonText(text.trim());
  if (Option.isSome(whole)) return [whole.value];
  return [...text.matchAll(FENCED_BLOCK)]
    .reverse()
    .flatMap((match) => Option.toArray(decodeJsonText((match[1] ?? "").trim())));
};

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
