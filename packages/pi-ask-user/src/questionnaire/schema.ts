import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 4;
export const MAX_CHOICES = 4;
export const MAX_CUSTOM_ANSWER_LENGTH = 4_000;
export const MAX_NOTE_LENGTH = 2_000;

const AskUserChoiceSchema = Type.Object({
  value: Type.String({
    minLength: 1,
    maxLength: 64,
    description: "Stable value returned when this choice is selected; unique within the question.",
  }),
  label: Type.String({
    minLength: 1,
    maxLength: 60,
    description: "Concise user-facing label, ideally 1-5 words.",
  }),
  description: Type.String({
    minLength: 1,
    maxLength: 400,
    description: "User-facing explanation of the choice and its trade-offs.",
  }),
  preview: Type.Optional(
    Type.String({
      maxLength: 4_000,
      description: "Optional markdown artifact preview, such as code, a diagram, or configuration.",
    }),
  ),
});

const AskUserQuestionSchema = Type.Object({
  key: Type.String({
    minLength: 1,
    maxLength: 32,
    description:
      "Unique stable identifier used to associate the returned answer with this question.",
  }),
  title: Type.String({
    minLength: 1,
    maxLength: 16,
    description: "Very short tab title, at most 16 characters.",
  }),
  prompt: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Complete, specific question shown to the user.",
  }),
  mode: StringEnum(["single", "multiple"] as const, {
    description: "Whether the user chooses one choice or any number of choices.",
  }),
  choices: Type.Array(AskUserChoiceSchema, {
    minItems: 2,
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
