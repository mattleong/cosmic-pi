import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { makeAsyncQuestionnaires, type AsyncDelivery } from "./async-service.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQuestionnaireQueue } from "./queue.ts";
import type { AskUserRequest, AskUserAsyncControl } from "./schema.ts";
import { AskUserHostError, AskUserValidationError, type AskUserAsyncError } from "./errors.ts";
import type { AsyncQuestionnaireResult } from "./async-model.ts";
import type { QuestionnaireOwner } from "./protocol.ts";
import {
  decodeOwnedFormRequest,
  type ExtensionFormOwner,
  type FormOutcome,
  type OwnedFormRequest,
} from "./form-protocol.ts";
import { validateFormOutcome, validateFormRequest } from "./form-validation.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export type AskUserHost = (
  request: AskUserRequest,
  opened?: Deferred.Deferred<void, AskUserHostError>,
  queued?: boolean,
) => Effect.Effect<AskUserOutcome, AskUserHostError>;

export type OwnedFormHost = (
  request: OwnedFormRequest,
  owner: ExtensionFormOwner,
) => Effect.Effect<FormOutcome, AskUserHostError>;

export interface QuestionnaireActivity {
  readonly admitted: (
    id: string,
    request: AskUserRequest | OwnedFormRequest,
    cancel: Effect.Effect<void>,
    owner?: QuestionnaireOwner | ExtensionFormOwner,
  ) => Effect.Effect<void>;
  readonly presenting: (id: string) => Effect.Effect<void>;
  readonly settled: (
    id: string,
    outcome: "submitted" | "cancelled" | "failed",
  ) => Effect.Effect<void>;
  readonly removed: (id: string) => Effect.Effect<void>;
}

const makeService = Effect.fn("AskUserService.make")(function* (
  host: AskUserHost,
  delivery?: AsyncDelivery,
  idPrefix = "ask",
  activity?: QuestionnaireActivity,
  formHost?: OwnedFormHost,
) {
  const queue = yield* makeQuestionnaireQueue;
  const counters = { blocking: yield* Ref.make(0), form: yield* Ref.make(0) };
  const async = yield* makeAsyncQuestionnaires(host, queue, delivery, idPrefix, activity);
  const controlAsync: (
    input: AskUserAsyncControl,
  ) => Effect.Effect<AsyncQuestionnaireResult, AskUserAsyncError> = async.control;
  /** One FIFO presentation: admit, publish Activity, race user cancellation, then settle. */
  const presentOwned = <A, E>(
    kind: keyof typeof counters,
    request: AskUserRequest | OwnedFormRequest,
    owner: QuestionnaireOwner | ExtensionFormOwner | undefined,
    present: () => Effect.Effect<A, E>,
    cancelled: NoInfer<A>,
    status: (value: A) => "submitted" | "cancelled",
  ) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const ticket = yield* queue.admit;
        const id = `${idPrefix}-${kind}-${yield* Ref.updateAndGet(counters[kind], (n) => n + 1)}`;
        const cancel = yield* Deferred.make<void>();
        return yield* restore(
          (
            activity?.admitted(
              id,
              request,
              Deferred.succeed(cancel, undefined).pipe(Effect.asVoid),
              owner,
            ) ?? Effect.void
          ).pipe(
            Effect.andThen(
              Effect.raceFirst(
                ticket.run((activity?.presenting(id) ?? Effect.void).pipe(Effect.andThen(present))),
                Deferred.await(cancel).pipe(Effect.as(cancelled)),
              ),
            ),
          ),
        ).pipe(
          Effect.onExit(
            (exit) =>
              activity?.settled(
                id,
                Exit.isSuccess(exit)
                  ? status(exit.value)
                  : Exit.hasInterrupts(exit)
                    ? "cancelled"
                    : "failed",
              ) ?? Effect.void,
          ),
          Effect.ensuring(ticket.close),
        );
      }),
    );
  const askRequest = Effect.fn("AskUserService.ask")(function* (
    request: AskUserRequest,
    owner?: QuestionnaireOwner,
  ) {
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    return yield* presentOwned(
      "blocking",
      normalized,
      owner,
      () => host(normalized, undefined, true),
      { outcome: "cancelled", answers: [] },
      (outcome) => outcome.outcome,
    );
  });
  const askForm = Effect.fn("AskUserService.askForm")(function* (
    input: OwnedFormRequest,
    owner: ExtensionFormOwner,
  ) {
    const request = decodeOwnedFormRequest(input);
    if (!request || validateFormRequest(request))
      return yield* new AskUserValidationError({ message: "Invalid owned form request." });
    if (!formHost)
      return yield* new AskUserHostError({
        operation: "render",
        message: "Owned forms are unavailable.",
      });
    return yield* presentOwned(
      "form",
      request,
      owner,
      // Validation stays inside the raced presentation, so an invalid answer settles as failed.
      () =>
        formHost(request, owner).pipe(
          Effect.flatMap((value) => {
            const outcome = validateFormOutcome(request, value);
            return outcome
              ? Effect.succeed(outcome)
              : Effect.fail(new AskUserValidationError({ message: "Invalid owned form answer." }));
          }),
        ),
      { action: "cancel" },
      (outcome) => (outcome.action === "accept" ? "submitted" : "cancelled"),
    );
  });
  return {
    askForm,
    ask: (request: AskUserRequest) => askRequest(request),
    askOwned: (request: AskUserRequest, owner: QuestionnaireOwner) => askRequest(request, owner),
    startAsync: async.start,
    controlAsync,
  };
});
export class AskUserService extends Context.Service<
  AskUserService,
  Readonly<Effect.Success<ReturnType<typeof makeService>>>
>()("pi-ask-user/questionnaire/service/AskUserService") {
  static layer(
    host: AskUserHost,
    delivery?: AsyncDelivery,
    idPrefix?: string,
    activity?: QuestionnaireActivity,
    formHost?: OwnedFormHost,
  ): Layer.Layer<AskUserService> {
    return Layer.effect(this, makeService(host, delivery, idPrefix, activity, formHost));
  }
}
