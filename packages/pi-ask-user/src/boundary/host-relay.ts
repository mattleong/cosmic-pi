import * as Effect from "effect/Effect";
import { requiresQuestionnaireRelay } from "./host-environment.ts";
import { AskUserHostError } from "../questionnaire/errors.ts";
import { AskUserService } from "../questionnaire/service.ts";
import {
  decodeQuestionnaireOutcome,
  queryQuestionnaireRelay,
  type AskUserRequest,
  type QuestionnaireEvents,
} from "../questionnaire/protocol.ts";

const relayFailure = (message: string) => AskUserHostError.make({ operation: "relay", message });

/**
 * Asks in this session, or through the root's relay in a child. `shown` runs once the
 * questionnaire opens on screen: here, or in the root when the relay reports it.
 */
export const askAtQuestionnaireBoundary = (
  events: QuestionnaireEvents,
  sessionId: string,
  request: AskUserRequest,
  shown: () => void = () => undefined,
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
        : AskUserService.use((service) => service.ask(request, Effect.sync(shown)));
    return Effect.tryPromise({
      try: (signal) => {
        // The relay may report late or twice; only the first report of a pending ask counts.
        let reported = false;
        const relayShown = () => {
          if (reported || signal.aborted) return;
          reported = true;
          shown();
        };
        return Promise.resolve<unknown>(relay.ask(request, signal, relayShown)).finally(() => {
          reported = true;
        });
      },
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
