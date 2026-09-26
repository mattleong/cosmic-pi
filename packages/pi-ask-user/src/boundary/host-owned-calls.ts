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
  OWNED_FORM_CAPABILITY_QUERY,
  decodeExtensionFormOwner,
  decodeOwnedFormRequest,
  type ExtensionFormOwner,
  type FormOutcome,
  type OwnedFormRequest,
} from "../questionnaire/form-protocol.ts";
import { validateFormOutcome, validateFormRequest } from "../questionnaire/form-validation.ts";
import {
  QUESTIONNAIRE_CAPABILITY_QUERY,
  QuestionnaireOwnerSchema,
  decodeQuestionnaireRequest,
  type AskUserOutcome,
  type AskUserRequest,
  type QuestionnaireEvents,
  type QuestionnaireOwner,
} from "../questionnaire/protocol.ts";

type OwnedCallEffect<Outcome> = Effect.Effect<
  Outcome,
  AskUserValidationError | AskUserHostError | AskUserAsyncError,
  AskUserService
>;
interface OwnedCallOptions<Outcome> {
  readonly events: QuestionnaireEvents;
  readonly sessionId: string;
  readonly generation: string;
  readonly isCurrent: () => boolean;
  /** Admission additionally requires this public prompt gate when supplied. */
  readonly canQueue?: () => boolean;
  readonly run: (effect: OwnedCallEffect<Outcome>, signal: AbortSignal) => Promise<Outcome>;
}
interface OwnedCallKind<Request, Owner, Outcome> {
  readonly query: string;
  readonly unavailable: string;
  readonly invalidOwner: string;
  readonly invalidRequest: string;
  readonly decodeOwner: <Input>(input: Input) => Owner | undefined;
  readonly decodeRequest: <Input>(input: Input) => Request | undefined;
  readonly key: (owner: Owner) => string;
  readonly effect: (request: Request, owner: Owner) => OwnedCallEffect<Outcome>;
  /** Revalidates a current answer; rejections then become unavailable. Omitted, they pass through. */
  readonly settle?: (request: Request, value: Outcome) => Outcome | undefined;
}
const queries = makeSessionCapabilityProtocol({ version: 1 });

/** One exact-owner registry: it owns only cancellation joins, never presentation or FIFO admission. */
function registerOwnedCalls<Request, Owner, Outcome>(
  kind: OwnedCallKind<Request, Owner, Outcome>,
  options: OwnedCallOptions<Outcome>,
): () => void {
  let live = true;
  const calls = new Map<string, { readonly abort: () => void; readonly settled: Promise<void> }>();
  const current = () => invokeHostCallback(() => live && options.isCurrent(), false);
  const unavailable = () => new AskUserRuntimeClosedError({ message: kind.unavailable });
  const invalid = (message: string) => Promise.reject(new AskUserValidationError({ message }));
  const capability = Object.freeze({
    version: 1,
    sessionId: options.sessionId,
    generation: options.generation,
    ask: (input: Request, rawOwner: Owner, signal: AbortSignal): Promise<Outcome> => {
      const owner = kind.decodeOwner(rawOwner);
      if (!owner) return invalid(kind.invalidOwner);
      const request = kind.decodeRequest(input);
      if (!request) return invalid(kind.invalidRequest);
      const key = kind.key(owner);
      if (!current() || calls.has(key) || calls.size >= MAX_PENDING_QUESTIONNAIRES)
        return Promise.reject(unavailable());
      const controller = new AbortController();
      // Install the receipt before start. Its microtask reads the owned run only
      // after this synchronous admission has assigned it, never an answer from a foreign host.
      let running: Promise<Outcome> | undefined;
      const settled = Promise.resolve()
        .then(() => running)
        .then(
          () => undefined,
          () => undefined,
        );
      const abort = () => controller.abort();
      const call = { abort, settled };
      const finish = () => {
        invokeHostCallback(() => signal.removeEventListener("abort", abort), undefined);
        if (calls.get(key) === call) calls.delete(key);
      };
      try {
        if (!signal || signal.aborted || options.canQueue?.() === false)
          return Promise.reject(unavailable());
        calls.set(key, call);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted || controller.signal.aborted || !current()) {
          finish();
          return Promise.reject(unavailable());
        }
        running = options.run(kind.effect(request, owner), controller.signal);
        return running.then(
          (value) => {
            const outcome = !kind.settle
              ? value
              : current() && !controller.signal.aborted
                ? kind.settle(request, value)
                : undefined;
            finish();
            if (outcome === undefined) throw unavailable();
            return outcome;
          },
          (error) => {
            finish();
            throw kind.settle ? unavailable() : error;
          },
        );
      } catch {
        abort();
        finish();
        return Promise.reject(unavailable());
      }
    },
    cancel: (rawOwner: Owner): Promise<void> => {
      const owner = kind.decodeOwner(rawOwner);
      if (!owner) return invalid(kind.invalidOwner);
      const call = calls.get(kind.key(owner));
      if (!call) return Promise.resolve();
      call.abort();
      return call.settled;
    },
  });
  // Discovery cannot acquire a call: decoding, `current`, and the best-effort `respond` never throw.
  const unsubscribe = options.events.on(kind.query, (input) => {
    const query = queries.normalizeQuery(input);
    if (query && current() && query.sessionId === options.sessionId) query.respond(capability);
  });
  return () => {
    if (!live) return;
    live = false;
    invokeHostCallback(unsubscribe, undefined); // Revocation must not block session teardown.
    for (const call of calls.values()) call.abort();
  };
}

const questionnaireKind: OwnedCallKind<AskUserRequest, QuestionnaireOwner, AskUserOutcome> = {
  query: QUESTIONNAIRE_CAPABILITY_QUERY,
  unavailable: "The root questionnaire capability is unavailable or its owner is already active.",
  invalidOwner: "Invalid questionnaire owner.",
  invalidRequest: "Invalid structured questionnaire request.",
  decodeOwner: (input) => decodeUnknownOrUndefined(QuestionnaireOwnerSchema, input),
  decodeRequest: decodeQuestionnaireRequest,
  key: (owner) => JSON.stringify([owner.runId, owner.assignmentEpoch, owner.requestId]),
  effect: (request, owner) => AskUserService.use((service) => service.askOwned(request, owner)),
};

/** Publishes the root capability; cancellation joins actual root runs, not foreign answer Promises. */
export const registerQuestionnaireCapability = (options: OwnedCallOptions<AskUserOutcome>) =>
  registerOwnedCalls(questionnaireKind, options);

const formKind: OwnedCallKind<OwnedFormRequest, ExtensionFormOwner, FormOutcome> = {
  query: OWNED_FORM_CAPABILITY_QUERY,
  unavailable: "The owned form capability is unavailable.",
  invalidOwner: "Invalid owned form request or owner.",
  invalidRequest: "Invalid owned form request or owner.",
  decodeOwner: decodeExtensionFormOwner,
  decodeRequest: (input) => {
    const request = decodeOwnedFormRequest(input);
    return request && !validateFormRequest(request) ? request : undefined;
  },
  key: (owner) => JSON.stringify([owner.extensionId, owner.operationId, owner.requestId]),
  effect: (request, owner) => AskUserService.use((service) => service.askForm(request, owner)),
  settle: validateFormOutcome,
};

/** Publishes the local-extension form capability for the current TUI/RPC generation only. */
export const registerOwnedFormCapability = (
  options: OwnedCallOptions<FormOutcome> & { readonly canQueue: () => boolean },
) => registerOwnedCalls(formKind, options);
