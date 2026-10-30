import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";

export const MAX_QUESTIONS = 6;
export const MAX_CHOICES = 6;
// Titles only label tabs and review rows, which shorten them; this bounds memory, not display.
export const MAX_TITLE_LENGTH = 120;
export const MAX_KEY_LENGTH = 32;
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

const questionFields = {
  key: Type.String({
    minLength: 1,
    maxLength: MAX_KEY_LENGTH,
    description:
      "Unique stable identifier used to associate the returned answer with this question.",
  }),
  title: Type.String({
    minLength: 1,
    maxLength: MAX_TITLE_LENGTH,
    description: "Very short tab title, ideally 1-2 words; long titles are shortened in tabs.",
  }),
  prompt: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "Complete, specific question shown to the user.",
  }),
};

export const AskUserChoiceQuestionSchema = Type.Object({
  ...questionFields,
  mode: StringEnum(["single", "multiple"] as const, {
    description: "Whether the user chooses one choice or any number of choices.",
  }),
  choices: Type.Array(AskUserChoiceSchema, {
    minItems: 2,
    maxItems: MAX_CHOICES,
    description: "Two to six concrete choices. A custom-answer action is appended automatically.",
  }),
});

const AskUserTextQuestionSchema = Type.Object(
  {
    ...questionFields,
    mode: StringEnum(["text"] as const, {
      description:
        "A required free-text answer, trimmed and limited to 4000 code units. Omit choices.",
    }),
  },
  { additionalProperties: false },
);

const AskUserQuestionSchema = Type.Union([AskUserChoiceQuestionSchema, AskUserTextQuestionSchema]);

export const AskUserParameters = Type.Object({
  questions: Type.Array(AskUserQuestionSchema, {
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description: "One to six questions presented as one questionnaire.",
  }),
});

export const MAX_WORK_DESCRIPTION_LENGTH = 500;

// Nonblank text is checked at admission: providers such as llama.cpp reject `pattern`.
const WorkDescription = Type.String({ minLength: 1, maxLength: MAX_WORK_DESCRIPTION_LENGTH });

export const AskUserAsyncParameters = Type.Object({
  ...AskUserParameters.properties,
  independentWork: Type.String({
    ...WorkDescription,
    description: "Specific work you can safely do without these answers.",
  }),
  blockedWork: Type.String({
    ...WorkDescription,
    description: "Specific decisions or work that must wait for these answers.",
  }),
});

export const AskUserAsyncControlParameters = Type.Object({
  action: StringEnum(["status", "await", "cancel"] as const),
  requestId: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 100,
      description:
        "Request ID. Required for await/cancel; omit for status to list retained requests.",
    }),
  ),
});

export type AskUserAsyncRequest = Static<typeof AskUserAsyncParameters>;
export type AskUserAsyncControl = Static<typeof AskUserAsyncControlParameters>;

export type AskUserChoice = Static<typeof AskUserChoiceSchema>;
export type AskUserChoiceQuestion = Static<typeof AskUserChoiceQuestionSchema>;
export type AskUserQuestion = Static<typeof AskUserQuestionSchema>;
export type AskUserRequest = Static<typeof AskUserParameters>;
