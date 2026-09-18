import { AskUserValidationError } from "./errors.ts";
import { MAX_CUSTOM_ANSWER_LENGTH, MAX_NOTE_LENGTH, type AskUserRequest } from "./schema.ts";

/** Fixed bounds use JavaScript code units after trimming; invalid input is never truncated. */
export function validateQuestionnaireInput(
  value: string,
  kind: "custom" | "text" | "note",
): { readonly value: string; readonly error?: undefined } | { readonly error: string } {
  const trimmed = value.trim();
  const maximum = kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
  if (kind !== "note" && trimmed.length === 0) return { error: "Write an answer first." };
  if (trimmed.length > maximum)
    return {
      error: `Keep this ${kind === "note" ? "note" : "answer"} under ${maximum} characters.`,
    };
  return { value: trimmed };
}

const RESERVED_LABELS = new Set(["write a custom answer", "continue", "submit answers", "cancel"]);

const fail = (position: string, problem: string): AskUserValidationError =>
  new AskUserValidationError({ message: `${position} ${problem}` });

export const normalizeAskUserRequest = (request: AskUserRequest): AskUserRequest => ({
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
  for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex++) {
    const question = request.questions[questionIndex]!;
    const questionPosition = `Question ${questionIndex + 1}`;
    if (question.key.length === 0) return fail(questionPosition, "has an empty key.");
    if (question.title.length === 0) return fail(questionPosition, "has an empty title.");
    if (question.prompt.length === 0) return fail(questionPosition, "has an empty prompt.");
    if (question.mode === "text") continue;

    for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex++) {
      const choice = question.choices[choiceIndex]!;
      const choicePosition = `${questionPosition}, choice ${choiceIndex + 1}`;
      if (choice.value.length === 0) return fail(choicePosition, "has an empty value.");
      if (choice.label.length === 0) return fail(choicePosition, "has an empty label.");
      if (choice.description.length === 0) return fail(choicePosition, "has an empty description.");
    }
  }

  const questionKeys = new Set<string>();
  for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex++) {
    const question = request.questions[questionIndex]!;
    const key = question.key;
    if (questionKeys.has(key)) {
      return fail(`Question ${questionIndex + 1}`, "has a duplicate key.");
    }
    questionKeys.add(key);
    if (question.mode === "text") continue;

    const values = new Set<string>();
    const labels = new Set<string>();
    for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex++) {
      const choice = question.choices[choiceIndex]!;
      const value = choice.value;
      const label = choice.label.toLowerCase();
      const position = `Question ${questionIndex + 1}, choice ${choiceIndex + 1}`;
      if (values.has(value)) return fail(position, "has a duplicate value.");
      if (labels.has(label)) return fail(position, "has a duplicate label.");
      if (RESERVED_LABELS.has(label)) return fail(position, "uses a reserved label.");
      values.add(value);
      labels.add(label);
    }
  }
  return undefined;
}
