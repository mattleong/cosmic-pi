import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { decodeUnknownOrUndefined, querySessionCapability } from "pi-cosmic-core";
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
const boundedArray = (maximum: number) =>
  decodeUnknownOrUndefined(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(maximum)));
const captureQuestions = boundedArray(MAX_QUESTIONS);
const captureChoices = boundedArray(MAX_CHOICES);

const captureRequest = (root: typeof RawRequest.Type): AskUserRequest | undefined => {
  try {
    const questions = captureQuestions(root.questions);
    if (!questions) return undefined;
    const captured = questions.map((item) => {
      const question = Schema.decodeUnknownSync(RawQuestion)(item);
      if (question.mode === "text") return question;
      const choices = captureChoices(question.choices);
      return Object.assign({}, question, {
        choices: choices?.map((choice) => Schema.decodeUnknownSync(RawChoice)(choice)),
      });
    });
    const request = normalizeAskUserRequest(
      Schema.decodeUnknownSync(QuestionnaireRequestSchema)({ questions: captured }),
    );
    return validateAskUserRequest(request) ? undefined : request;
  } catch {
    return undefined;
  }
};

const captureOutcome = (root: typeof RawOutcome.Type): AskUserOutcome | undefined => {
  try {
    const answers = captureQuestions(root.answers);
    if (!answers) return undefined;
    const captured = answers.map((item) => {
      const answer = Schema.decodeUnknownSync(RawAnswer)(item);
      if (answer.kind === "text" && Schema.is(Schema.String)(answer.text)) {
        const checked = validateQuestionnaireInput(answer.text, "text");
        return checked.error === undefined
          ? Object.assign({}, answer, { text: checked.value })
          : undefined;
      }
      return answer.kind === "choices"
        ? Object.assign({}, answer, {
            values: captureChoices(answer.values),
            labels: captureChoices(answer.labels),
          })
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

export const decodeQuestionnaireRequest = flow(decodeUnknownOrUndefined(RawRequest), (root) =>
  root === undefined ? undefined : captureRequest(root),
);
export const decodeQuestionnaireOutcome = flow(decodeUnknownOrUndefined(RawOutcome), (root) =>
  root === undefined ? undefined : captureOutcome(root),
);

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
