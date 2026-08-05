import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MIN_CHOICES = 2;
export const MAX_CHOICES = 4;
export const MAX_KEY_LENGTH = 32;
export const MAX_TITLE_LENGTH = 16;
export const MAX_PROMPT_LENGTH = 500;
export const MAX_VALUE_LENGTH = 64;
export const MAX_LABEL_LENGTH = 60;
export const MAX_DESCRIPTION_LENGTH = 400;
export const MAX_PREVIEW_LENGTH = 4_000;
export const MAX_CUSTOM_ANSWER_LENGTH = 4_000;
export const MAX_NOTE_LENGTH = 2_000;

export const AskUserChoiceSchema = Type.Object({
  value: Type.String({
    minLength: 1,
    maxLength: MAX_VALUE_LENGTH,
    description: "Stable value returned when this choice is selected; unique within the question.",
  }),
  label: Type.String({
    minLength: 1,
    maxLength: MAX_LABEL_LENGTH,
    description: "Concise user-facing label, ideally 1-5 words.",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: MAX_DESCRIPTION_LENGTH,
    description: "User-facing explanation of the choice and its trade-offs.",
  }),
  preview: Type.Optional(
    Type.String({
      maxLength: MAX_PREVIEW_LENGTH,
      description: "Optional markdown artifact preview, such as code, a diagram, or configuration.",
    }),
  ),
});

export const AskUserQuestionSchema = Type.Object({
  key: Type.String({
    minLength: 1,
    maxLength: MAX_KEY_LENGTH,
    description:
      "Unique stable identifier used to associate the returned answer with this question.",
  }),
  title: Type.String({
    minLength: 1,
    maxLength: MAX_TITLE_LENGTH,
    description: "Very short tab title, at most 16 characters.",
  }),
  prompt: Type.String({
    minLength: 1,
    maxLength: MAX_PROMPT_LENGTH,
    description: "Complete, specific question shown to the user.",
  }),
  mode: StringEnum(["single", "multiple"] as const, {
    description: "Whether the user chooses one choice or any number of choices.",
  }),
  choices: Type.Array(AskUserChoiceSchema, {
    minItems: MIN_CHOICES,
    maxItems: MAX_CHOICES,
    description: "Two to four concrete choices. A custom-answer action is appended automatically.",
  }),
});

export const AskUserParameters = Type.Object({
  questions: Type.Array(AskUserQuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "One to four questions presented as one questionnaire.",
  }),
});

export type AskUserChoice = Static<typeof AskUserChoiceSchema>;
export type AskUserQuestion = Static<typeof AskUserQuestionSchema>;
export type AskUserRequest = Static<typeof AskUserParameters>;
