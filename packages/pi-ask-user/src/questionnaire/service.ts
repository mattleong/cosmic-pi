import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { HostDialogs } from "../boundary/host-dialogs.ts";
import type { AskUserRequest } from "../tools/schema.ts";
import { AskUserRuntimeClosedError, type AskUserError } from "./errors.ts";
import type { AskUserOutcome } from "./model.ts";
import { normalizeAskUserRequest, validateAskUserRequest } from "./validation.ts";

export interface AskUserServiceContract {
  readonly ask: (request: AskUserRequest) => Effect.Effect<AskUserOutcome, AskUserError>;
}

const makeService = Effect.fn("AskUserService.make")(function* () {
  const host = yield* HostDialogs;
  const lock = yield* Semaphore.make(1);
  // Open while the runtime admits requests; the scope finalizer closes it atomically.
  const admissions = yield* Latch.make(true);
  const ask: AskUserServiceContract["ask"] = (request) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!admissions.isOpen()) {
          return yield* new AskUserRuntimeClosedError({
            message: "The ask-user session runtime is closed.",
          });
        }
        const normalized = normalizeAskUserRequest(request);
        const validation = validateAskUserRequest(normalized);
        if (validation) return yield* validation;
        return yield* host.ask(normalized);
      }),
    );
  yield* Effect.addFinalizer(() => Latch.close(admissions));
  return { ask } satisfies AskUserServiceContract;
});

export class AskUserService extends Context.Service<AskUserService, AskUserServiceContract>()(
  "pi-ask-user/questionnaire/service/AskUserService",
) {
  static readonly layer = Layer.effect(this, makeService());

  static override readonly use = <A, E>(
    f: (service: AskUserServiceContract) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}
