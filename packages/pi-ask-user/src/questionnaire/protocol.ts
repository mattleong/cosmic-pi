import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { flow } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { decodeUnknownOrUndefined, ForeignCallable, querySessionCapability } from "pi-cosmic-core";
import { MAX_CHOICES, MAX_QUESTIONS, MAX_TITLE_LENGTH, type AskUserRequest } from "./schema.ts";
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
  assignmentEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
        title: text(MAX_TITLE_LENGTH),
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
        title: text(MAX_TITLE_LENGTH),
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

const decodeRawQuestion = decodeUnknownOrUndefined(RawQuestion);
const decodeRawChoice = decodeUnknownOrUndefined(RawChoice);
const decodeRawAnswer = decodeUnknownOrUndefined(RawAnswer);
const decodeRequest = decodeUnknownOrUndefined(QuestionnaireRequestSchema);
const decodeOutcome = decodeUnknownOrUndefined(QuestionnaireOutcomeSchema);

const captureRequest = (root: typeof RawRequest.Type): AskUserRequest | undefined => {
  const questions = captureQuestions(root.questions);
  if (!questions) return undefined;
  const captured = [];
  for (const item of questions) {
    const question = decodeRawQuestion(item);
    if (!question) return undefined;
    if (question.mode === "text") {
      captured.push(question);
      continue;
    }
    const choices = [];
    for (const choice of captureChoices(question.choices) ?? []) {
      const decoded = decodeRawChoice(choice);
      if (!decoded) return undefined;
      choices.push(decoded);
    }
    captured.push(Object.assign({}, question, { choices }));
  }
  const decoded = decodeRequest({ questions: captured });
  if (!decoded) return undefined;
  const request = normalizeAskUserRequest(decoded);
  return validateAskUserRequest(request) ? undefined : request;
};

const captureOutcome = (root: typeof RawOutcome.Type): AskUserOutcome | undefined => {
  const answers = captureQuestions(root.answers);
  if (!answers) return undefined;
  const captured = [];
  for (const item of answers) {
    const answer = decodeRawAnswer(item);
    if (!answer) return undefined;
    if (answer.kind === "text" && Predicate.isString(answer.text)) {
      const checked = validateQuestionnaireInput(answer.text, "text");
      if (checked.error !== undefined) return undefined;
      captured.push(Object.assign({}, answer, { text: checked.value }));
    } else if (answer.kind === "choices") {
      captured.push(
        Object.assign({}, answer, {
          values: captureChoices(answer.values),
          labels: captureChoices(answer.labels),
        }),
      );
    } else captured.push(answer);
  }
  return decodeOutcome({ outcome: root.outcome, answers: captured });
};

export const decodeQuestionnaireRequest = flow(decodeUnknownOrUndefined(RawRequest), (root) =>
  root === undefined ? undefined : captureRequest(root),
);
export const decodeQuestionnaireOutcome = flow(decodeUnknownOrUndefined(RawOutcome), (root) =>
  root === undefined ? undefined : captureOutcome(root),
);

// Candidates come from other extensions: their callbacks are admitted only as callable, so
// consumers invoke them through Effect.tryPromise and decode what they return.
const DiscoveredRelaySchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  ask: ForeignCallable<[request: AskUserRequest, signal: AbortSignal]>(),
});
const DiscoveredCapabilitySchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  generation: Schema.String,
  cancel: ForeignCallable<[owner: QuestionnaireOwner]>(),
  ask: ForeignCallable<[request: AskUserRequest, owner: QuestionnaireOwner, signal: AbortSignal]>(),
});
type DiscoveredQuestionnaireRelay = typeof DiscoveredRelaySchema.Type;
type DiscoveredQuestionnaireCapability = typeof DiscoveredCapabilitySchema.Type;
const isDiscoveredRelay = Schema.is(DiscoveredRelaySchema);
const isDiscoveredCapability = Schema.is(DiscoveredCapabilitySchema);

export const queryQuestionnaireRelay = (events: QuestionnaireEvents, sessionId: string) =>
  querySessionCapability<unknown, DiscoveredQuestionnaireRelay>(
    events,
    QUESTIONNAIRE_RELAY_QUERY,
    { version: 1, sessionId },
    (value) => (isDiscoveredRelay(value) && value.sessionId === sessionId ? value : undefined),
  ).candidates.at(-1);
export const queryQuestionnaireCapability = (events: QuestionnaireEvents, sessionId: string) =>
  querySessionCapability<unknown, DiscoveredQuestionnaireCapability>(
    events,
    QUESTIONNAIRE_CAPABILITY_QUERY,
    { version: 1, sessionId },
    (value) => (isDiscoveredCapability(value) && value.sessionId === sessionId ? value : undefined),
  ).candidates.at(-1);
