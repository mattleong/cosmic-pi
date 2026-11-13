import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AskUserAnswer, AskUserOutcome } from "../../src/questionnaire/model.ts";
import type {
  AskUserAsyncRequest,
  AskUserChoiceQuestion,
  AskUserRequest,
} from "../../src/questionnaire/schema.ts";
import { AskUserService } from "../../src/questionnaire/service.ts";

export const acquireService = (...args: Parameters<typeof AskUserService.layer>) =>
  Effect.gen(function* () {
    const context = yield* Layer.buildWithScope(AskUserService.layer(...args), yield* Effect.scope);
    return Context.get(context, AskUserService);
  });

/** Forks `effect` and runs it to its first suspension before returning the fiber. */
export const forkNow = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.forkChild(effect, { startImmediately: true });

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

/** A one-question request whose question answers under `key`. */
export const keyedRequest = (key: string): AskUserRequest => ({
  questions: [{ ...defaultQuestion, key }],
});

const ordinalChoices = [
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

export const noExecution = () => {
  throw new Error("Rendering must not execute");
};

export const hostile = <Target extends object>(target: Target, key: string): Target =>
  Object.defineProperty(target, key, {
    get() {
      throw new Error("hostile");
    },
  });

export const hostileContent = (text: string) => [
  { type: "text", text: `${text}\u001b[31m fallback` },
  { type: "image", data: "secret" },
  { type: "text", text: 123 },
  null,
  hostile({ type: "text" }, "text"),
  { type: "text", text: "after" },
];
