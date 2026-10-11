import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import { QUESTIONNAIRE_CAPABILITY_QUERY, type AskUserRequest } from "pi-ask-user/protocol";

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

export const eventBus = (): EventBus => createEventBus();

const capabilityQueries = makeSessionCapabilityProtocol({ version: 1 });

export const answerCapabilityQueries = <Capability>(events: EventBus, answer: () => Capability) =>
  events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (input) =>
    capabilityQueries.normalizeQuery(input)?.respond(answer()),
  );
