import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { AskUserValidationError } from "./errors.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserChoice,
  type AskUserChoiceQuestion,
  type AskUserQuestion,
  type AskUserRequest,
} from "./schema.ts";

export function validateQuestionnaireInput(
  value: string,
  kind: "custom" | "text" | "note",
): { readonly value: string; readonly error?: undefined } | { readonly error: string } {
  const trimmed = Str.trim(value);
  const maximum = kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
  if (kind !== "note" && trimmed.length === 0) return { error: "Write an answer first" };
  if (trimmed.length > maximum)
    return {
      error: `Keep this ${kind === "note" ? "note" : "answer"} under ${maximum} characters`,
    };
  return { value: trimmed };
}

// A choice with this label would pose as the built-in custom-answer action but return its value
// instead of the user's text. Continue, review, and cancel actions never sit among choices.
const RESERVED_LABELS = new Set(["write a custom answer"]);

const fail = (position: string, problem: string): AskUserValidationError =>
  AskUserValidationError.make({ message: `${position} ${problem}` });

interface QuestionnaireInput {
  readonly questions: ReadonlyArray<
    | Exclude<AskUserQuestion, AskUserChoiceQuestion>
    | (Omit<AskUserChoiceQuestion, "choices"> & { readonly choices: ReadonlyArray<AskUserChoice> })
  >;
}

export const normalizeAskUserRequest = (request: QuestionnaireInput): AskUserRequest => ({
  questions: Arr.map(request.questions, (question) => {
    const base = {
      key: Str.trim(question.key),
      title: Str.trim(question.title),
      prompt: Str.trim(question.prompt),
    };
    if (question.mode === "text") return { ...base, mode: question.mode };
    return {
      ...base,
      mode: question.mode,
      choices: Arr.map(question.choices, (choice) => {
        const baseChoice = {
          ...choice,
          value: Str.trim(choice.value),
          label: Str.trim(choice.label),
          description: Str.trim(choice.description),
        };
        return choice.preview === undefined
          ? baseChoice
          : { ...baseChoice, preview: Str.trim(choice.preview) };
      }),
    };
  }),
});

export function validateAskUserRequest(
  request: AskUserRequest,
): AskUserValidationError | undefined {
  for (const [questionIndex, question] of request.questions.entries()) {
    const questionPosition = `Question ${questionIndex + 1}`;
    for (const field of ["key", "title", "prompt"] as const)
      if (question[field].length === 0) return fail(questionPosition, `has an empty ${field}`);
    if (question.mode === "text") continue;

    for (const [choiceIndex, choice] of question.choices.entries()) {
      const choicePosition = `${questionPosition}, choice ${choiceIndex + 1}`;
      for (const field of ["value", "label", "description"] as const)
        if (choice[field].length === 0) return fail(choicePosition, `has an empty ${field}`);
    }
  }

  const questionKeys = new Set<string>();
  for (const [questionIndex, question] of request.questions.entries()) {
    if (questionKeys.has(question.key)) {
      return fail(`Question ${questionIndex + 1}`, "has a duplicate key");
    }
    questionKeys.add(question.key);
    if (question.mode === "text") continue;

    const values = new Set<string>();
    const labels = new Set<string>();
    for (const [choiceIndex, choice] of question.choices.entries()) {
      const label = Str.toLowerCase(choice.label);
      const position = `Question ${questionIndex + 1}, choice ${choiceIndex + 1}`;
      if (values.has(choice.value)) return fail(position, "has a duplicate value");
      if (labels.has(label)) return fail(position, "has a duplicate label");
      if (RESERVED_LABELS.has(label)) return fail(position, "uses a reserved label");
      values.add(choice.value);
      labels.add(label);
    }
  }
  return undefined;
}
