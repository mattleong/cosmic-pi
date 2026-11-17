import * as Effect from "effect/Effect";
import { AskUserService } from "../questionnaire/service.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "../questionnaire/validation.ts";
import {
  decodeQuestionnaireAsker,
  decodeQuestionnaireOutcome,
  queryQuestionnaireAskers,
  type AskUserRequest,
  type QuestionnaireEvents,
} from "../questionnaire/protocol.ts";

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
 * and then the questionnaire opens here after all. `shown` runs once the questionnaire opens on
 * screen, wherever that is.
 */
export const askInSession = Effect.fn("AskUserHost.askInSession")(function* (
  events: QuestionnaireEvents,
  sessionId: string,
  request: AskUserRequest,
  shown: () => void = () => undefined,
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
