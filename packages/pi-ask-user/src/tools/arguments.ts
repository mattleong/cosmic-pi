import { flow } from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { JsonObject, JsonValue } from "pi-cosmic-core";
import { omitBlankOptionalArguments, toolArgumentPreparer } from "pi-cosmic-core/tool-arguments";
import type { Static, TSchema } from "typebox";
import { Check } from "typebox/value";
import { AskUserChoiceQuestionSchema } from "../questionnaire/schema.ts";

const decodeArgumentsObject = Schema.decodeUnknownOption(
  Schema.Record(Schema.String, Schema.MutableJson),
);
const omitBlankChoiceQuestionOptionals = omitBlankOptionalArguments(AskUserChoiceQuestionSchema);

const isEmpty = (value: JsonValue): boolean =>
  value === null ||
  (Predicate.isString(value) && value.trim().length === 0) ||
  (Array.isArray(value) && value.length === 0);

// Blank optionals are dropped only through declared properties, not into the question union, so
// each question gets the shape its mode selects: text questions ignore empty choices, which they
// don't use, and choice questions drop blank previews.
const withSelectedShape = (question: JsonObject): JsonObject => {
  if (question.mode !== "text") return omitBlankChoiceQuestionOptionals(question);
  const { choices, ...textQuestion } = question;
  return choices === undefined || isEmpty(choices) ? textQuestion : question;
};

const withSelectedQuestionShapes = (args: JsonObject): JsonObject =>
  Array.isArray(args.questions)
    ? {
        ...args,
        questions: args.questions.map((question) =>
          Option.match(decodeArgumentsObject(question), {
            onNone: () => question,
            onSome: withSelectedShape,
          }),
        ),
      }
    : args;

/**
 * Pi `prepareArguments` hook for a questionnaire tool: drops null and blank optionals, including
 * unused empty choices on text questions, and reports issues only for the shape each question's
 * mode selects.
 */
export const questionnaireArgumentPreparer = <Parameters extends TSchema>(
  name: string,
  parameters: Parameters,
) =>
  flow(
    decodeArgumentsObject,
    Option.map(withSelectedQuestionShapes),
    // The shared preparer rejects non-object arguments without echoing them.
    Option.getOrNull,
    toolArgumentPreparer(name, parameters, (value): value is Static<Parameters> =>
      Check(parameters, value),
    ),
  );
