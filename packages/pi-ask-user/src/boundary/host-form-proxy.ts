import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import { AskUserService } from "../questionnaire/service.ts";
import {
  AskUserRuntimeClosedError,
  AskUserValidationError,
  type AskUserAsyncError,
  type AskUserHostError,
} from "../questionnaire/errors.ts";
import { MAX_PENDING_QUESTIONNAIRES } from "../questionnaire/queue.ts";
import {
  OWNED_FORM_CAPABILITY_QUERY,
  decodeExtensionFormOwner,
  decodeOwnedFormRequest,
  type ExtensionFormOwner,
  type FormOutcome,
  type OwnedFormCapability,
  type OwnedFormRequest,
} from "../questionnaire/form-protocol.ts";
import { validateFormOutcome, validateFormRequest } from "../questionnaire/form-validation.ts";
import type { QuestionnaireEvents } from "../questionnaire/protocol.ts";

const Query = Schema.Struct({
  version: Schema.Literal(1),
  sessionId: Schema.String,
  respond: Schema.Unknown,
});
const keyOf = (owner: ExtensionFormOwner) =>
  JSON.stringify([owner.extensionId, owner.operationId, owner.requestId]);

/** This registry owns only cancellation joins; AskUserService owns presentation and FIFO admission. */
export function registerOwnedFormCapability(options: {
  readonly events: QuestionnaireEvents;
  readonly sessionId: string;
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly canQueue: () => boolean;
  readonly run: (
    effect: Effect.Effect<
      FormOutcome,
      AskUserValidationError | AskUserHostError | AskUserAsyncError,
      AskUserService
    >,
    signal: AbortSignal,
  ) => Promise<FormOutcome>;
}): () => void {
  let live = true;
  const calls = new Map<string, { readonly abort: () => void; readonly settled: Promise<void> }>();
  const current = () => {
    try {
      return live && options.isCurrent();
    } catch {
      return false;
    }
  };
  const unavailable = () =>
    new AskUserRuntimeClosedError({ message: "The owned form capability is unavailable." });
  const invalid = () =>
    new AskUserValidationError({ message: "Invalid owned form request or owner." });
  const capability: OwnedFormCapability = Object.freeze({
    version: 1,
    sessionId: options.sessionId,
    generation: options.generation,
    ask: (input: OwnedFormRequest, rawOwner: ExtensionFormOwner, signal: AbortSignal) => {
      const owner = decodeExtensionFormOwner(rawOwner);
      const request = decodeOwnedFormRequest(input);
      if (!owner || !request || validateFormRequest(request)) return Promise.reject(invalid());
      const key = keyOf(owner);
      if (!current() || calls.has(key) || calls.size >= MAX_PENDING_QUESTIONNAIRES)
        return Promise.reject(unavailable());
      const controller = new AbortController();
      let running: Promise<FormOutcome> | undefined;
      const settled = Promise.resolve()
        .then(() => running)
        .then(
          () => undefined,
          () => undefined,
        );
      const abort = () => controller.abort();
      const call = { abort, settled };
      const finish = () => {
        try {
          signal.removeEventListener("abort", abort);
        } catch {
          /* Best effort listener removal. */
        }
        if (calls.get(key) === call) calls.delete(key);
      };
      try {
        if (!options.canQueue() || !signal || signal.aborted) return Promise.reject(unavailable());
        calls.set(key, call);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        if (!current() || controller.signal.aborted) {
          finish();
          return Promise.reject(unavailable());
        }
        running = options.run(
          AskUserService.use((service) => service.askForm(request, owner)),
          controller.signal,
        );
        return running.then(
          (value) => {
            const outcome =
              current() && !controller.signal.aborted
                ? validateFormOutcome(request, value)
                : undefined;
            finish();
            if (!outcome) throw unavailable();
            return outcome;
          },
          () => {
            finish();
            throw unavailable();
          },
        );
      } catch {
        abort();
        finish();
        return Promise.reject(unavailable());
      }
    },
    cancel: (rawOwner: ExtensionFormOwner) => {
      const owner = decodeExtensionFormOwner(rawOwner);
      if (!owner) return Promise.reject(invalid());
      const call = calls.get(keyOf(owner));
      if (!call) return Promise.resolve();
      call.abort();
      return call.settled;
    },
  });
  const unsubscribe = options.events.on(OWNED_FORM_CAPABILITY_QUERY, (input) => {
    try {
      const query = Schema.decodeUnknownSync(Query)(input);
      if (current() && query.sessionId === options.sessionId && Predicate.isFunction(query.respond))
        query.respond(capability);
    } catch {
      /* Synchronous optional discovery. */
    }
  });
  return () => {
    if (!live) return;
    live = false;
    try {
      unsubscribe();
    } catch {
      /* Revocation must not block session teardown. */
    }
    for (const call of calls.values()) call.abort();
  };
}
