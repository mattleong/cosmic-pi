import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import type * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { makeAsyncQuestionnaires, type AsyncDelivery } from "./async-service.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeQuestionnaireQueue } from "./queue.ts";
import type { AskUserRequest } from "./schema.ts";
import type { AskUserHostError } from "./errors.ts";
import type { QuestionnaireOwner } from "./protocol.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

/** Mount and hide/resume signals an async presenter observes; blocking questionnaires omit them. */
export interface QuestionnairePresence {
  readonly opened: Deferred.Deferred<void, AskUserHostError>;
  readonly visibility: Queue.Enqueue<"open" | "hidden">;
}

export type AskUserHost = (
  request: AskUserRequest,
  presence?: QuestionnairePresence,
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

export const noQuestionnaireActivity: QuestionnaireActivity = {
  admitted: () => Effect.void,
  presenting: () => Effect.void,
  settled: () => Effect.void,
  removed: () => Effect.void,
};

const makeService = Effect.fn("AskUserService.make")(function* (
  host: AskUserHost,
  delivery?: AsyncDelivery,
  idPrefix = "ask",
  activity: QuestionnaireActivity = noQuestionnaireActivity,
) {
  const queue = yield* makeQuestionnaireQueue;
  const blockingCount = yield* Ref.make(0);
  const async = yield* makeAsyncQuestionnaires(host, queue, delivery, idPrefix, activity);
  /** One FIFO presentation: admit, publish Activity, race user cancellation, then settle. */
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
        const id = `${idPrefix}-blocking-${yield* Ref.updateAndGet(blockingCount, (n) => n + 1)}`;
        const cancel = yield* Deferred.make<void>();
        return yield* restore(
          activity
            .admitted(id, normalized, Effect.asVoid(Deferred.succeed(cancel, undefined)), owner)
            .pipe(
              Effect.andThen(
                Effect.raceFirst(
                  ticket.run(
                    activity
                      .presenting(id)
                      .pipe(Effect.andThen(() => host(normalized, undefined, true))),
                  ),
                  Deferred.await(cancel).pipe(
                    Effect.as<AskUserOutcome>({ outcome: "cancelled", answers: [] }),
                  ),
                ),
              ),
            ),
        ).pipe(
          Effect.onExit((exit) =>
            activity.settled(
              id,
              Exit.isSuccess(exit)
                ? exit.value.outcome
                : Exit.hasInterrupts(exit)
                  ? "cancelled"
                  : "failed",
            ),
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
  Readonly<Effect.Success<ReturnType<typeof makeService>>>
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
