// Shared questionnaire relay fixtures: one single-choice request and Pi's event bus.
import { createEventBus } from "@earendil-works/pi-coding-agent";
import type { AskUserRequest } from "pi-ask-user/protocol";

export const pickQuestionnaire: AskUserRequest = {
  questions: [
    {
      key: "pick",
      title: "Pick",
      prompt: "Which?",
      mode: "single",
      choices: [
        { value: "a", label: "A", description: "First" },
        { value: "b", label: "B", description: "Second" },
      ],
    },
  ],
};

/** Pi's event bus, whose test handlers read the shape of the query they answer. */
export const eventBus = (): {
  readonly on: (name: string, handler: (event: any) => void) => () => void;
  readonly emit: <Event>(name: string, event: Event) => void;
} => createEventBus();
