import { AskUserValidationError } from "./errors.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserChoice,
  type AskUserChoiceQuestion,
  type AskUserQuestion,
  type AskUserRequest,
} from "./schema.ts";

/** Fixed bounds use JavaScript code units after trimming; invalid input is never truncated. */
export function validateQuestionnaireInput(
  value: string,
  kind: "custom" | "text" | "note",
): { readonly value: string; readonly error?: undefined } | { readonly error: string } {
  const trimmed = value.trim();
  const maximum = kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
  if (kind !== "note" && trimmed.length === 0) return { error: "Write an answer first" };
  if (trimmed.length > maximum)
    return {
      error: `Keep this ${kind === "note" ? "note" : "answer"} under ${maximum} characters`,
    };
  return { value: trimmed };
}

const RESERVED_LABELS = new Set(["write a custom answer", "continue", "submit answers", "cancel"]);

const fail = (position: string, problem: string): AskUserValidationError =>
  new AskUserValidationError({ message: `${position} ${problem}` });

/** Tool input or a decoded transport request, whose arrays are readonly. */
interface QuestionnaireInput {
  readonly questions: ReadonlyArray<
    | Exclude<AskUserQuestion, AskUserChoiceQuestion>
    | (Omit<AskUserChoiceQuestion, "choices"> & { readonly choices: ReadonlyArray<AskUserChoice> })
  >;
}

/** A detached, trimmed copy; callers never share question or choice objects with their input. */
export const normalizeAskUserRequest = (request: QuestionnaireInput): AskUserRequest => ({
  questions: request.questions.map((question) => {
    const base = {
      key: question.key.trim(),
      title: question.title.trim(),
      prompt: question.prompt.trim(),
    };
    if (question.mode === "text") return { ...base, mode: question.mode };
    return {
      ...base,
      mode: question.mode,
      choices: question.choices.map((choice) => {
        const baseChoice = {
          ...choice,
          value: choice.value.trim(),
          label: choice.label.trim(),
          description: choice.description.trim(),
        };
        return choice.preview === undefined
          ? baseChoice
          : { ...baseChoice, preview: choice.preview.trim() };
      }),
    };
  }),
});

/**
 * Internal contract: validate only `normalizeAskUserRequest` output, whose required
 * text fields are already trimmed. Failures stay positional and content-free.
 */
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
      const label = choice.label.toLowerCase();
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
