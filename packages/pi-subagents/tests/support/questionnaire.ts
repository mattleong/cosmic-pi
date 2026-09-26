// Shared questionnaire relay fixtures: one single-choice request and a Pi event-bus stand-in.
import { EventEmitter } from "node:events";
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

/** EventEmitter-backed `{ on, emit }` with Pi's unsubscribe-returning `on`. */
export const eventBus = () => {
  const emitter = new EventEmitter();
  return {
    on: (name: string, handler: (event: any) => void) => {
      emitter.on(name, handler);
      return () => {
        emitter.off(name, handler);
      };
    },
    emit: (name: string, event: any) => {
      emitter.emit(name, event);
    },
  };
};
