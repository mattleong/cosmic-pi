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
) => Effect.Effect<AskUserOutcome, AskUserHostError>;

const makeService = Effect.fn("AskUserService.make")(function* (host: AskUserHost) {
  const lock = yield* Semaphore.make(1);
  const ask = Effect.fn("AskUserService.ask")(function* (request: AskUserRequest) {
    const normalized = normalizeAskUserRequest(request);
    const validationError = validateAskUserRequest(normalized);
    if (validationError) return yield* validationError;
    return yield* lock.withPermit(host(normalized));
  });
  return { ask };
});

export class AskUserService extends Context.Service<
  AskUserService,
  {
    readonly ask: (
      request: AskUserRequest,
    ) => Effect.Effect<AskUserOutcome, AskUserValidationError | AskUserHostError>;
  }
>()("pi-ask-user/questionnaire/service/AskUserService") {
  static layer(host: AskUserHost): Layer.Layer<AskUserService> {
    return Layer.effect(this, makeService(host));
  }
}
