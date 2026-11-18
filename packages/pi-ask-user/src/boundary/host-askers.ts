import * as Effect from "effect/Effect";
import { AskUserService } from "../questionnaire/service.ts";
import { normalizeAskUserRequest } from "../questionnaire/validation.ts";
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
  const service = yield* AskUserService;
  let reported = false;
  const reportShown = () => {
    if (reported) return;
    reported = true;
    shown();
  };
  return yield* service.ask(request, Effect.sync(reportShown), (asked, presentHere) =>
    Effect.gen(function* () {
      const asker = yield* findAsker(events, sessionId, asked.askedBy);
      if (!asker) return yield* presentHere(asked);
      const named = { ...asked, askedBy: asker.name };
      // Keep the caller's normalized fallback independent of the data passed to foreign code.
      const fallback = normalizeAskUserRequest(named);
      let join = Effect.void;
      const elsewhere = yield* Effect.tryPromise((signal) => {
        const pending = Promise.resolve<unknown>(
          asker.present(named, signal, () => {
            if (!signal.aborted) reportShown();
          }),
        );
        // tryPromise signals withdrawal on interruption, but abort alone isn't acknowledgement.
        join = Effect.tryPromise(() => pending).pipe(Effect.ignore);
        return pending;
      }).pipe(
        Effect.onInterrupt(() => join),
        Effect.map(decodeQuestionnaireOutcome),
        Effect.orElseSucceed(() => undefined),
      );
      return elsewhere ?? (yield* presentHere(fallback));
    }),
  );
});
