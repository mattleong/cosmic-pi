import { AskUserValidationError } from "./errors.ts";
import type { AskUserRequest } from "../tools/schema.ts";

const RESERVED_LABELS = new Set(["write a custom answer", "continue", "submit answers", "cancel"]);

export const normalizeAskUserRequest = (request: AskUserRequest): AskUserRequest => ({
  questions: request.questions.map((question) => ({
    ...question,
    key: question.key.trim(),
    title: question.title.trim(),
    prompt: question.prompt.trim(),
    choices: question.choices.map((choice) =>
      (() => {
        const objectPart517_0 = {
          ...choice,
          value: choice.value.trim(),
          label: choice.label.trim(),
          description: choice.description.trim(),
        };
        const objectPart517_1 =
          choice.preview === undefined
            ? objectPart517_0
            : { ...objectPart517_0, preview: choice.preview.trim() };
        return objectPart517_1;
      })(),
    ),
  })),
});

export function validateAskUserRequest(
  request: AskUserRequest,
): AskUserValidationError | undefined {
  const questionKeys = new Set<string>();
  for (const question of request.questions) {
    const key = question.key.trim();
    if (questionKeys.has(key)) {
      return new AskUserValidationError({ message: `Question key must be unique: ${key}` });
    }
    questionKeys.add(key);

    const values = new Set<string>();
    const labels = new Set<string>();
    for (const choice of question.choices) {
      const value = choice.value.trim();
      const label = choice.label.trim().toLocaleLowerCase();
      if (values.has(value)) {
        return new AskUserValidationError({
          message: `Choice value must be unique in question ${key}: ${value}`,
        });
      }
      if (labels.has(label)) {
        return new AskUserValidationError({
          message: `Choice label must be unique in question ${key}: ${choice.label.trim()}`,
        });
      }
      if (RESERVED_LABELS.has(label)) {
        return new AskUserValidationError({
          message: `Choice label is reserved in question ${key}: ${choice.label.trim()}`,
        });
      }
      values.add(value);
      labels.add(label);
    }
  }
  return undefined;
}
