import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";
import { makeSessionCapabilityProtocol } from "pi-cosmic-core";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  type AskUserOutcome,
  type AskUserRequest,
  type QuestionnaireCapability,
} from "pi-ask-user/protocol";

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

type UntrustedOutcome = AskUserOutcome | Readonly<Record<string, never>>;

interface UntrustedCapability extends Omit<QuestionnaireCapability, "ask"> {
  readonly ask: (...args: Parameters<QuestionnaireCapability["ask"]>) => Promise<UntrustedOutcome>;
}

export const answerCapabilityQueries = (events: EventBus, answer: () => UntrustedCapability) =>
  events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (input) =>
    capabilityQueries.normalizeQuery(input)?.respond(answer()),
  );
