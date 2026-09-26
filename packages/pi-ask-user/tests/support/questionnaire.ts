import type { AskUserAnswer, AskUserOutcome } from "../../src/questionnaire/model.ts";
import type {
  AskUserAsyncRequest,
  AskUserChoiceQuestion,
  AskUserRequest,
} from "../../src/questionnaire/schema.ts";

export const defaultQuestion: AskUserChoiceQuestion = {
  key: "choice",
  title: "Choice",
  prompt: "Choose.",
  mode: "single",
  choices: [
    { value: "a", label: "A", description: "Choose A." },
    { value: "b", label: "B", description: "Choose B." },
  ],
};

export const ordinalChoices = [
  { value: "a", label: "A", description: "First" },
  { value: "b", label: "B", description: "Second" },
];

export const routeRequest: AskUserRequest = {
  questions: [
    {
      key: "route",
      title: "Route",
      prompt: "Choose route",
      mode: "single",
      choices: ordinalChoices,
    },
  ],
};

export const asyncRequest: AskUserAsyncRequest = {
  questions: [defaultQuestion],
  independentWork: "Inspect",
  blockedWork: "Choose",
};

export const formOwner = {
  extensionId: "pi-mcp",
  operationId: "operation",
  requestId: "request",
  label: "MCP",
};

export const emptyForm = { kind: "form", message: "private", fields: [] } as const;

export const submitted = (...answers: AskUserAnswer[]): AskUserOutcome => ({
  outcome: "submitted",
  answers,
});

export const cancelled: AskUserOutcome = { outcome: "cancelled", answers: [] };
