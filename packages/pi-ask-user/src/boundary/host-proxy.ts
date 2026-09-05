import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { AskUserService } from "../questionnaire/service.ts";
import { MAX_PENDING_QUESTIONNAIRES } from "../questionnaire/queue.ts";
import {
  AskUserRuntimeClosedError,
  AskUserValidationError,
  type AskUserHostError,
  type AskUserAsyncError,
} from "../questionnaire/errors.ts";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  QuestionnaireOwnerSchema,
  decodeQuestionnaireRequest,
  type QuestionnaireCapability,
  type QuestionnaireEvents,
  type AskUserOutcome,
  type AskUserRequest,
  type QuestionnaireOwner,
} from "../questionnaire/protocol.ts";

const QuerySchema = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  respond: Schema.Unknown,
});
const ownerKey = (owner: QuestionnaireOwner) =>
  JSON.stringify([owner.runId, owner.assignmentEpoch, owner.requestId]);
interface OwnedCall {
  readonly abort: () => void;
  readonly settled: Promise<void>;
}

/** Owns cancellation acknowledgements for actual root runs, not foreign answer Promises. */
export function registerQuestionnaireCapability(options: {
  readonly events: QuestionnaireEvents;
  readonly sessionId: string;
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly run: (
    effect: Effect.Effect<
      AskUserOutcome,
      AskUserValidationError | AskUserHostError | AskUserAsyncError,
      AskUserService
    >,
    signal: AbortSignal,
  ) => Promise<AskUserOutcome>;
}): () => void {
  let live = true;
  const calls = new Map<string, OwnedCall>();
  const current = () => live && options.isCurrent();
  const unavailable = () =>
    new AskUserRuntimeClosedError({
      message: "The root questionnaire capability is unavailable or its owner is already active.",
    });
  const capability: QuestionnaireCapability = Object.freeze({
    version: 1,
    sessionId: options.sessionId,
    generation: options.generation,
    ask: (input: AskUserRequest, rawOwner: QuestionnaireOwner, signal: AbortSignal) => {
      let owner: QuestionnaireOwner;
      try {
        owner = Schema.decodeUnknownSync(QuestionnaireOwnerSchema)(rawOwner);
      } catch {
        return Promise.reject(
          new AskUserValidationError({ message: "Invalid questionnaire owner." }),
        );
      }
      const key = ownerKey(owner);
      if (!current() || !signal || calls.has(key) || calls.size >= MAX_PENDING_QUESTIONNAIRES)
        return Promise.reject(unavailable());
      const request = decodeQuestionnaireRequest(input);
      if (!request)
        return Promise.reject(
          new AskUserValidationError({ message: "Invalid structured questionnaire request." }),
        );
      const controller = new AbortController();
      // Install the receipt before start. Its microtask reads the owned run only
      // after this synchronous admission has assigned it, never an answer from a foreign host.
      let running: Promise<AskUserOutcome> | undefined;
      const settled = Promise.resolve()
        .then(() => running)
        .then(
          () => undefined,
          () => undefined,
        );
      const abort = () => controller.abort();
      const call: OwnedCall = { abort, settled };
      calls.set(key, call);
      const finish = () => {
        try {
          signal.removeEventListener("abort", abort);
        } catch {
          /* Best-effort host listener cleanup. */
        }
        if (calls.get(key) === call) calls.delete(key);
      };
      try {
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        running = options.run(
          AskUserService.use((service) => service.askOwned(request, owner)),
          controller.signal,
        );
        return running.then(
          (outcome) => {
            finish();
            return outcome;
          },
          (error) => {
            finish();
            throw error;
          },
        );
      } catch {
        abort();
        finish();
        return Promise.reject(unavailable());
      }
    },
    cancel: (rawOwner: QuestionnaireOwner) => {
      try {
        const owner = Schema.decodeUnknownSync(QuestionnaireOwnerSchema)(rawOwner);
        const call = calls.get(ownerKey(owner));
        if (!call) return Promise.resolve();
        call.abort();
        return call.settled;
      } catch {
        return Promise.reject(
          new AskUserValidationError({ message: "Invalid questionnaire owner." }),
        );
      }
    },
  });
  const unsubscribe = options.events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (event) => {
    try {
      if (
        !current() ||
        !Schema.is(QuerySchema)(event) ||
        event.sessionId !== options.sessionId ||
        !Predicate.isFunction(event.respond)
      )
        return;
      event.respond(capability);
    } catch {
      /* Discovery cannot acquire a questionnaire. */
    }
  });
  return () => {
    if (!live) return;
    live = false;
    unsubscribe();
    for (const call of calls.values()) call.abort();
  };
}
