import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { querySessionCapability } from "pi-cosmic-core";
import { MAX_CHOICES, MAX_QUESTIONS, type AskUserRequest } from "./schema.ts";
import {
  normalizeAskUserRequest,
  validateAskUserRequest,
  validateQuestionnaireInput,
} from "./validation.ts";

export type { AskUserRequest } from "./schema.ts";
export const QUESTIONNAIRE_CAPABILITY_QUERY = "pi-ask-user:capability-query:v1";
export const QUESTIONNAIRE_RELAY_QUERY = "pi-ask-user:relay-query:v1";
export type QuestionnaireEvents = Pick<ExtensionAPI["events"], "on" | "emit">;
const text = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
export const QuestionnaireOwnerSchema = Schema.Struct({
  runId: text(256),
  assignmentEpoch: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  requestId: text(256),
});
export type QuestionnaireOwner = typeof QuestionnaireOwnerSchema.Type;
export interface QuestionnaireCapability {
  readonly version: 1;
  readonly sessionId: string;
  readonly generation: string;
  /** Revoke the exact owned request synchronously, then join its UI/editor cleanup. */
  readonly cancel: (owner: QuestionnaireOwner) => Promise<void>;
  readonly ask: (
    request: AskUserRequest,
    owner: QuestionnaireOwner,
    signal: AbortSignal,
  ) => Promise<AskUserOutcome>;
}
export interface QuestionnaireRelay {
  readonly version: 1;
  readonly sessionId: string;
  readonly ask: (request: AskUserRequest, signal: AbortSignal) => Promise<AskUserOutcome>;
}

export const QuestionnaireRequestSchema = Schema.Struct({
  questions: Schema.Array(
    Schema.Union([
      Schema.Struct({
        key: text(32),
        title: text(16),
        prompt: text(500),
        mode: Schema.Literals(["single", "multiple"]),
        choices: Schema.Array(
          Schema.Struct({
            value: text(64),
            label: text(60),
            description: text(400),
            preview: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
          }),
        ).check(Schema.isMinLength(2), Schema.isMaxLength(MAX_CHOICES)),
      }),
      Schema.Struct({
        key: text(32),
        title: text(16),
        prompt: text(500),
        mode: Schema.Literal("text"),
        choices: Schema.optionalKey(Schema.Never),
      }),
    ]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUESTIONS)),
});
const answerFields = {
  key: text(32),
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
};
export const QuestionnaireOutcomeSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled"), answers: Schema.Tuple([]) }),
  Schema.Struct({
    outcome: Schema.Literal("submitted"),
    answers: Schema.Array(
      Schema.Union([
        Schema.Struct({ ...answerFields, kind: Schema.Literal("custom"), text: text(4000) }),
        Schema.Struct({
          ...answerFields,
          kind: Schema.Literal("text"),
          text: text(4000).check(Schema.isPattern(/\S/)),
        }),
        Schema.Struct({
          ...answerFields,
          kind: Schema.Literal("choices"),
          values: Schema.Array(text(64)).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(MAX_CHOICES),
          ),
          labels: Schema.Array(text(60)).check(
            Schema.isMinLength(1),
            Schema.isMaxLength(MAX_CHOICES),
          ),
        }),
      ]),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_QUESTIONS)),
  }),
]);
export type AskUserOutcome = typeof QuestionnaireOutcomeSchema.Type;
// Decode each bounded record once before inspecting nested arrays. Later schema
// validation reads only detached data, never a second hostile getter value.
const RawRequest = Schema.Struct({ questions: Schema.Unknown });
const RawQuestion = Schema.Struct({
  key: Schema.Unknown,
  title: Schema.Unknown,
  prompt: Schema.Unknown,
  mode: Schema.Unknown,
  choices: Schema.optionalKey(Schema.Unknown),
});
const RawChoice = Schema.Struct({
  value: Schema.Unknown,
  label: Schema.Unknown,
  description: Schema.Unknown,
  preview: Schema.optionalKey(Schema.Unknown),
});
const RawOutcome = Schema.Struct({ outcome: Schema.Unknown, answers: Schema.Unknown });
const RawAnswer = Schema.Struct({
  key: Schema.Unknown,
  kind: Schema.Unknown,
  note: Schema.optionalKey(Schema.Unknown),
  text: Schema.optionalKey(Schema.Unknown),
  values: Schema.optionalKey(Schema.Unknown),
  labels: Schema.optionalKey(Schema.Unknown),
});
const SmallLength = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(MAX_QUESTIONS),
);
const captureArray = <Input>(input: Input, maximum = MAX_QUESTIONS): unknown[] | undefined => {
  if (!Array.isArray(input)) return undefined;
  const length: unknown = input.length;
  if (!Schema.is(SmallLength)(length) || length > maximum) return undefined;
  return Array.from({ length }, (_, index) => input[index]);
};
export const decodeQuestionnaireRequest = <Input>(input: Input): AskUserRequest | undefined => {
  try {
    const root = Schema.decodeUnknownSync(RawRequest)(input);
    const questions = captureArray(root.questions);
    if (!questions) return undefined;
    const captured = questions.map((input) => {
      const question = Schema.decodeUnknownSync(RawQuestion)(input);
      if (question.mode === "text") return question;
      const choices = captureArray(question.choices, MAX_CHOICES);
      return {
        ...question,
        choices: choices?.map((choice) => Schema.decodeUnknownSync(RawChoice)(choice)),
      };
    });
    const request = normalizeAskUserRequest(
      Schema.decodeUnknownSync(QuestionnaireRequestSchema)({ questions: captured }),
    );
    return validateAskUserRequest(request) ? undefined : request;
  } catch {
    return undefined;
  }
};
export const decodeQuestionnaireOutcome = <Input>(input: Input): AskUserOutcome | undefined => {
  try {
    const root = Schema.decodeUnknownSync(RawOutcome)(input);
    const answers = captureArray(root.answers);
    if (!answers) return undefined;
    const captured = answers.map((input) => {
      const answer = Schema.decodeUnknownSync(RawAnswer)(input);
      if (answer.kind === "text" && Schema.is(Schema.String)(answer.text)) {
        const checked = validateQuestionnaireInput(answer.text, "text");
        return checked.error === undefined ? { ...answer, text: checked.value } : undefined;
      }
      return answer.kind === "choices"
        ? {
            ...answer,
            values: captureArray(answer.values, MAX_CHOICES),
            labels: captureArray(answer.labels, MAX_CHOICES),
          }
        : answer;
    });
    return Schema.decodeUnknownSync(QuestionnaireOutcomeSchema)({
      outcome: root.outcome,
      answers: captured,
    });
  } catch {
    return undefined;
  }
};

/** Missing or rejected providers are unavailable, never a local fallback. Last valid wins. */
export const queryQuestionnaireRelay = (
  events: QuestionnaireEvents,
  sessionId: string,
): QuestionnaireRelay | undefined =>
  querySessionCapability(
    events,
    QUESTIONNAIRE_RELAY_QUERY,
    { version: 1, sessionId },
    (value: QuestionnaireRelay) =>
      value?.version === 1 && value.sessionId === sessionId && Predicate.isFunction(value.ask)
        ? value
        : undefined,
  ).candidates.at(-1);
/** Optional root capability; its ask takes an additional authenticated owner. Last valid wins. */
export const queryQuestionnaireCapability = (
  events: QuestionnaireEvents,
  sessionId: string,
): QuestionnaireCapability | undefined =>
  querySessionCapability(
    events,
    QUESTIONNAIRE_CAPABILITY_QUERY,
    { version: 1, sessionId },
    (value: QuestionnaireCapability) =>
      value?.version === 1 &&
      value.sessionId === sessionId &&
      Predicate.isString(value.generation) &&
      Predicate.isFunction(value.ask) &&
      Predicate.isFunction(value.cancel)
        ? value
        : undefined,
  ).candidates.at(-1);
