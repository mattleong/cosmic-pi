import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { HostDialogs } from "../boundary/host-dialogs.ts";
import type { AskUserRequest } from "./schema.ts";
import { AskUserHostError, AskUserValidationError } from "./errors.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

interface AskUserServiceContract {
  readonly ask: (
    request: AskUserRequest,
  ) => Effect.Effect<AskUserOutcome, AskUserValidationError | AskUserHostError>;
}

const makeService = Effect.fn("AskUserService.make")(function* () {
  const host = yield* HostDialogs;
  const lock = yield* Semaphore.make(1);
  const ask: AskUserServiceContract["ask"] = (request) =>
    lock.withPermit(
      Effect.suspend(
        (): Effect.Effect<AskUserOutcome, AskUserValidationError | AskUserHostError> => {
          const normalized = normalizeAskUserRequest(request);
          return validateAskUserRequest(normalized) ?? host.ask(normalized);
        },
      ),
    );
  return { ask } satisfies AskUserServiceContract;
});

export class AskUserService extends Context.Service<AskUserService, AskUserServiceContract>()(
  "pi-ask-user/questionnaire/service/AskUserService",
) {
  static readonly layer = Layer.effect(this, makeService());
}
