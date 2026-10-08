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

export const submitted = (...answers: AskUserAnswer[]): AskUserOutcome => ({
  outcome: "submitted",
  answers,
});

export const cancelled: AskUserOutcome = { outcome: "cancelled", answers: [] };

/** Registered tools under presentation tests must never execute. */
export const noExecution = () => {
  throw new Error("Rendering must not execute");
};

/** `target` with `key` behind a throwing getter, as hostile replayed data may arrive. */
export const hostile = <Target extends object>(target: Target, key: string): Target =>
  Object.defineProperty(target, key, {
    get() {
      throw new Error("hostile");
    },
  });

/** Replayed answers whose note is malformed or unreadable; renderers decline both. */
export const malformedNoteAnswers = () => [
  { key: "route", kind: "custom", text: "Scenic", note: 123 },
  hostile({ key: "route", kind: "custom", text: "Scenic" }, "note"),
];

/** Replayed content around `text`: a control sequence, an image, and malformed or throwing parts. */
export const hostileContent = (text: string) => [
  { type: "text", text: `${text}\u001b[31m fallback` },
  { type: "image", data: "secret" },
  { type: "text", text: 123 },
  null,
  hostile({ type: "text" }, "text"),
  { type: "text", text: "after" },
];
