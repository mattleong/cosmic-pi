import type * as Effect from "effect/Effect";
import {
  decodeUnknownOrUndefined,
  invokeHostCallback,
  makeSessionCapabilityProtocol,
} from "pi-cosmic-core";
import { AskUserService } from "../questionnaire/service.ts";
import {
  AskUserRuntimeClosedError,
  AskUserValidationError,
  type AskUserAsyncError,
  type AskUserHostError,
} from "../questionnaire/errors.ts";
import { MAX_PENDING_QUESTIONNAIRES } from "../questionnaire/queue.ts";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  QuestionnaireOwnerSchema,
  decodeQuestionnaireRequest,
  type AskUserOutcome,
  type AskUserRequest,
  type QuestionnaireEvents,
  type QuestionnaireOwner,
} from "../questionnaire/protocol.ts";

interface QuestionnaireCapabilityOptions {
  readonly events: QuestionnaireEvents;
  readonly sessionId: string;
  readonly generation: string;
  readonly isCurrent: () => boolean;
  readonly run: (
    effect: Effect.Effect<
      AskUserOutcome,
      AskUserValidationError | AskUserHostError | AskUserAsyncError | AskUserRuntimeClosedError,
      AskUserService
    >,
    signal: AbortSignal,
  ) => Promise<AskUserOutcome>;
}
const queries = makeSessionCapabilityProtocol({ version: 1 });
const UNAVAILABLE =
  "The root questionnaire capability is unavailable or its owner is already active.";
const INVALID_OWNER = "Invalid questionnaire owner.";
const decodeOwner = decodeUnknownOrUndefined(QuestionnaireOwnerSchema);
const invalid = (message: string) => Promise.reject(new AskUserValidationError({ message }));
const ownerKey = (owner: QuestionnaireOwner) =>
  JSON.stringify([owner.runId, owner.assignmentEpoch, owner.requestId]);

export function registerQuestionnaireCapability(
  options: QuestionnaireCapabilityOptions,
): () => void {
  let live = true;
  const calls = new Map<string, { readonly abort: () => void; readonly settled: Promise<void> }>();
  const current = () => invokeHostCallback(() => live && options.isCurrent(), false);
  const unavailable = () => new AskUserRuntimeClosedError({ message: UNAVAILABLE });
  const capability = Object.freeze({
    version: 1,
    sessionId: options.sessionId,
    generation: options.generation,
    ask: (
      input: AskUserRequest,
      rawOwner: QuestionnaireOwner,
      signal: AbortSignal,
    ): Promise<AskUserOutcome> => {
      const owner = decodeOwner(rawOwner);
      if (!owner) return invalid(INVALID_OWNER);
      const request = decodeQuestionnaireRequest(input);
      if (!request) return invalid("Invalid structured questionnaire request.");
      const key = ownerKey(owner);
      if (!current() || calls.has(key) || calls.size >= MAX_PENDING_QUESTIONNAIRES)
        return Promise.reject(unavailable());
      const controller = new AbortController();
      let running: Promise<AskUserOutcome> | undefined;
      const settled = Promise.resolve()
        .then(() => running)
        .then(
          () => undefined,
          () => undefined,
        );
      const abort = () => controller.abort();
      const call = { abort, settled };
      const finish = () => {
        if (calls.get(key) === call) calls.delete(key);
      };
      try {
        if (!signal || signal.aborted) return Promise.reject(unavailable());
        const linked = AbortSignal.any([signal, controller.signal]);
        calls.set(key, call);
        if (linked.aborted || !current()) {
          finish();
          return Promise.reject(unavailable());
        }
        running = options.run(
          AskUserService.use((service) => service.askOwned(request, owner)),
          linked,
        );
        return running.then(
          (outcome) => {
            finish();
            return outcome;
          },
          (cause: unknown) => {
            finish();
            throw cause;
          },
        );
      } catch {
        abort();
        finish();
        return Promise.reject(unavailable());
      }
    },
    cancel: (rawOwner: QuestionnaireOwner): Promise<void> => {
      const owner = decodeOwner(rawOwner);
      if (!owner) return invalid(INVALID_OWNER);
      const call = calls.get(ownerKey(owner));
      if (!call) return Promise.resolve();
      call.abort();
      return call.settled;
    },
  });
  const unsubscribe = options.events.on(QUESTIONNAIRE_CAPABILITY_QUERY, (input) => {
    const query = queries.normalizeQuery(input);
    if (query && current() && query.sessionId === options.sessionId) query.respond(capability);
  });
  return () => {
    if (!live) return;
    live = false;
    invokeHostCallback(unsubscribe, undefined);
    for (const call of calls.values()) call.abort();
  };
}
