import type * as Deferred from "effect/Deferred";
import { asyncBusy, makeAsyncQuestionnaires, type AsyncDelivery } from "./async-service.ts";
import type { AsyncQuestionnaireSnapshot, AsyncQuestionnaireResult } from "./async-model.ts";
import type { AskUserAsyncRequest, AskUserAsyncControl } from "./schema.ts";
import type { AskUserAsyncError } from "./errors.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { AskUserRequest } from "./schema.ts";
import { AskUserHostError, AskUserValidationError } from "./errors.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export type AskUserHost = (
  request: AskUserRequest,
  opened?: Deferred.Deferred<void, AskUserHostError>,
) => Effect.Effect<AskUserOutcome, AskUserHostError>;

const makeService = Effect.fn("AskUserService.make")(function* (
  host: AskUserHost,
  delivery?: AsyncDelivery,
  idPrefix = "ask",
) {
  const lock = yield* Semaphore.make(1);
  const async = yield* makeAsyncQuestionnaires(host, lock, delivery, idPrefix);
  const ask = Effect.fn("AskUserService.ask")(function* (request: AskUserRequest) {
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    if (yield* async.hasPending) return yield* asyncBusy();
    return yield* lock.withPermit(host(normalized));
  });
  return { ask, startAsync: async.start, controlAsync: async.control };
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
  ): Layer.Layer<AskUserService> {
    return Layer.effect(this, makeService(host, delivery, idPrefix));
  }
}
