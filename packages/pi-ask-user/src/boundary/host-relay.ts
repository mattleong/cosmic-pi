import * as Effect from "effect/Effect";
import { requiresQuestionnaireRelay } from "./host-environment.ts";
import { AskUserHostError } from "../questionnaire/errors.ts";
import { AskUserService } from "../questionnaire/service.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "../questionnaire/validation.ts";
import {
  decodeQuestionnaireAsker,
  decodeQuestionnaireOutcome,
  queryQuestionnaireAskers,
  queryQuestionnaireRelay,
  type AskUserRequest,
  type QuestionnaireEvents,
} from "../questionnaire/protocol.ts";

const relayFailure = (message: string) => AskUserHostError.make({ operation: "relay", message });

/**
 * Who a questionnaire asked in this session is for, when the extension that runs agents here
 * knows the `askedBy` it names. A capability that throws or answers something else knows no one.
 */
const findAsker = (events: QuestionnaireEvents, sessionId: string, askedBy: string | undefined) =>
  Effect.try(() =>
    askedBy === undefined
      ? undefined
      : decodeQuestionnaireAsker(queryQuestionnaireAskers(events, sessionId)?.find(askedBy)),
  ).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Asks where the user is looking: in the asker's own session when it is on screen, and otherwise
 * here, under the asker's name. The asker's session may leave the screen before the user answers,
 * and then the questionnaire opens here after all.
 */
const askInSession = Effect.fn("AskUserHost.askInSession")(function* (
  events: QuestionnaireEvents,
  sessionId: string,
  request: AskUserRequest,
  shown: () => void,
) {
  const normalized = normalizeAskUserRequest(request);
  const validationError = validateAskUserRequest(normalized);
  if (validationError) return yield* validationError;
  const asker = yield* findAsker(events, sessionId, normalized.askedBy);
  if (!asker)
    return yield* AskUserService.use((service) => service.ask(normalized, Effect.sync(shown)));
  const named = { ...normalized, askedBy: asker.name };
  const elsewhere = yield* Effect.tryPromise((signal) =>
    Promise.resolve<unknown>(asker.present(named, signal, shown)),
  ).pipe(
    Effect.map(decodeQuestionnaireOutcome),
    Effect.orElseSucceed(() => undefined),
  );
  return (
    elsewhere ?? (yield* AskUserService.use((service) => service.ask(named, Effect.sync(shown))))
  );
});

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
        : askInSession(events, sessionId, request, shown);
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
