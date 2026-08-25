import { AskUserValidationError } from "./errors.ts";
import type { AskUserRequest } from "./schema.ts";

const RESERVED_LABELS = new Set(["write a custom answer", "continue", "submit answers", "cancel"]);

const fail = (position: string, problem: string): AskUserValidationError =>
  new AskUserValidationError({ message: `${position} ${problem}` });

export const normalizeAskUserRequest = (request: AskUserRequest): AskUserRequest => ({
  questions: request.questions.map((question) => ({
    ...question,
    key: question.key.trim(),
    title: question.title.trim(),
    prompt: question.prompt.trim(),
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
  })),
});

/**
 * Internal contract: validate only `normalizeAskUserRequest` output, whose keys,
 * values, and labels are already trimmed. Failures stay positional and content-free.
 */
export function validateAskUserRequest(
  request: AskUserRequest,
): AskUserValidationError | undefined {
  const questionKeys = new Set<string>();
  for (let questionIndex = 0; questionIndex < request.questions.length; questionIndex++) {
    const question = request.questions[questionIndex]!;
    const key = question.key;
    if (questionKeys.has(key)) {
      return fail(`Question ${questionIndex + 1}`, "has a duplicate key.");
    }
    questionKeys.add(key);

    const values = new Set<string>();
    const labels = new Set<string>();
    for (let choiceIndex = 0; choiceIndex < question.choices.length; choiceIndex++) {
      const choice = question.choices[choiceIndex]!;
      const value = choice.value;
      const label = choice.label.toLocaleLowerCase();
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
