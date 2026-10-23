import * as Effect from "effect/Effect";
import { AskUserHostError } from "../questionnaire/errors.ts";
import { AskUserService } from "../questionnaire/service.ts";
import {
  decodeQuestionnaireOutcome,
  queryQuestionnaireRelay,
  type AskUserRequest,
  type QuestionnaireEvents,
} from "../questionnaire/protocol.ts";

const hasRelayMarker = (environment: Readonly<NodeJS.ProcessEnv>): boolean =>
  environment.PI_SUBAGENT_CHILD === "1" && (environment.PI_SUBAGENT_RUN_ID?.trim() ?? "") !== "";
export const requiresQuestionnaireRelay = (): boolean => hasRelayMarker(process.env);
const relayFailure = (message: string) => AskUserHostError.make({ operation: "relay", message });

export const askAtQuestionnaireBoundary = (
  events: QuestionnaireEvents,
  sessionId: string,
  request: AskUserRequest,
) =>
  Effect.suspend(() => {
    const relay = queryQuestionnaireRelay(events, sessionId);
    if (!relay)
      return requiresQuestionnaireRelay()
        ? Effect.fail(
            relayFailure(
              "The root questionnaire relay is unavailable. Do not fall back to a child-local dialog.",
            ),
          )
        : AskUserService.use((service) => service.ask(request));
    return Effect.tryPromise({
      try: (signal) => Promise.resolve<unknown>(relay.ask(request, signal)),
      catch: () => relayFailure("The root questionnaire relay failed or was revoked."),
    }).pipe(
      Effect.flatMap((input) => {
        const outcome = decodeQuestionnaireOutcome(input);
        return outcome
          ? Effect.succeed(outcome)
          : Effect.fail(relayFailure("The root questionnaire relay returned an invalid result."));
      }),
    );
  });
