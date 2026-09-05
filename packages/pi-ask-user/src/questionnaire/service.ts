import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { makeAsyncQuestionnaires, type AsyncDelivery } from "./async-service.ts";
import type { AsyncQuestionnaireSnapshot, AsyncQuestionnaireResult } from "./async-model.ts";
import type { AskUserAsyncRequest, AskUserAsyncControl } from "./schema.ts";
import type { AskUserAsyncError } from "./errors.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQuestionnaireQueue } from "./queue.ts";
import type { AskUserRequest } from "./schema.ts";
import { AskUserHostError, AskUserValidationError } from "./errors.ts";
import type { QuestionnaireOwner } from "./protocol.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export type AskUserHost = (
  request: AskUserRequest,
  opened?: Deferred.Deferred<void, AskUserHostError>,
  queued?: boolean,
) => Effect.Effect<AskUserOutcome, AskUserHostError>;

export interface QuestionnaireActivity {
  readonly admitted: (
    id: string,
    request: AskUserRequest,
    cancel: Effect.Effect<void>,
    owner?: QuestionnaireOwner,
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
) {
  const queue = yield* makeQuestionnaireQueue;
  const counter = yield* Ref.make(0);
  const async = yield* makeAsyncQuestionnaires(host, queue, delivery, idPrefix, activity);
  const askRequest = Effect.fn("AskUserService.ask")(function* (
    request: AskUserRequest,
    owner?: QuestionnaireOwner,
  ) {
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const ticket = yield* queue.admit;
        const id = `${idPrefix}-blocking-${yield* Ref.updateAndGet(counter, (n) => n + 1)}`;
        const cancel = yield* Deferred.make<void>();
        return yield* restore(
          (
            activity?.admitted(
              id,
              normalized,
              Deferred.succeed(cancel, undefined).pipe(Effect.asVoid),
              owner,
            ) ?? Effect.void
          ).pipe(
            Effect.andThen(
              Effect.raceFirst(
                ticket.run(
                  (activity?.presenting(id) ?? Effect.void).pipe(
                    Effect.andThen(host(normalized, undefined, true)),
                  ),
                ),
                Deferred.await(cancel).pipe(
                  Effect.as({ outcome: "cancelled", answers: [] } as const),
                ),
              ),
            ),
          ),
        ).pipe(
          Effect.onExit(
            (exit) =>
              activity?.settled(
                id,
                Exit.isSuccess(exit)
                  ? exit.value.outcome
                  : Exit.hasInterrupts(exit)
                    ? "cancelled"
                    : "failed",
              ) ?? Effect.void,
          ),
          Effect.ensuring(ticket.close),
        );
      }),
    );
  });
  return {
    ask: (request: AskUserRequest) => askRequest(request),
    askOwned: (request: AskUserRequest, owner: QuestionnaireOwner) => askRequest(request, owner),
    startAsync: async.start,
    controlAsync: async.control,
  };
});

export class AskUserService extends Context.Service<
  AskUserService,
  {
    readonly ask: (
      request: AskUserRequest,
    ) => Effect.Effect<
      AskUserOutcome,
      AskUserValidationError | AskUserHostError | AskUserAsyncError
    >;
    readonly askOwned: (
      request: AskUserRequest,
      owner: QuestionnaireOwner,
    ) => Effect.Effect<
      AskUserOutcome,
      AskUserValidationError | AskUserHostError | AskUserAsyncError
    >;
    readonly startAsync: (
      request: AskUserAsyncRequest,
    ) => Effect.Effect<
      AsyncQuestionnaireSnapshot,
      AskUserValidationError | AskUserHostError | AskUserAsyncError
    >;
    readonly controlAsync: (
      input: AskUserAsyncControl,
    ) => Effect.Effect<AsyncQuestionnaireResult, AskUserAsyncError>;
  }
>()("pi-ask-user/questionnaire/service/AskUserService") {
  static layer(
    host: AskUserHost,
    delivery?: AsyncDelivery,
    idPrefix?: string,
    activity?: QuestionnaireActivity,
  ): Layer.Layer<AskUserService> {
    return Layer.effect(this, makeService(host, delivery, idPrefix, activity));
  }
}
