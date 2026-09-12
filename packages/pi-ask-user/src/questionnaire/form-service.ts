import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { AskUserHostError, AskUserValidationError } from "./errors.ts";
import {
  decodeOwnedFormRequest,
  type ExtensionFormOwner,
  type FormOutcome,
  type OwnedFormRequest,
} from "./form-protocol.ts";
import { validateFormOutcome, validateFormRequest } from "./form-validation.ts";
import type { QuestionnaireQueue } from "./queue.ts";
import type { QuestionnaireActivity } from "./service.ts";

export type OwnedFormHost = (
  request: OwnedFormRequest,
  owner: ExtensionFormOwner,
) => Effect.Effect<FormOutcome, AskUserHostError>;

/** Constructed once by AskUserService using its real FIFO, never a second queue/runtime. */
export const makeOwnedForms = Effect.fn("AskUserService.makeOwnedForms")(function* (
  queue: QuestionnaireQueue,
  host: OwnedFormHost | undefined,
  prefix: string,
  activity?: QuestionnaireActivity,
) {
  const counter = yield* Ref.make(0);
  return Effect.fn("AskUserService.askForm")(function* (
    input: OwnedFormRequest,
    owner: ExtensionFormOwner,
  ) {
    const request = decodeOwnedFormRequest(input);
    if (!request || validateFormRequest(request))
      return yield* new AskUserValidationError({ message: "Invalid owned form request." });
    if (!host)
      return yield* new AskUserHostError({
        operation: "render",
        message: "Owned forms are unavailable.",
      });
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const ticket = yield* queue.admit;
        const id = `${prefix}-form-${yield* Ref.updateAndGet(counter, (n) => n + 1)}`;
        const cancel = yield* Deferred.make<void>();
        return yield* restore(
          (
            activity?.admittedForm?.(
              id,
              request,
              Deferred.succeed(cancel, undefined).pipe(Effect.asVoid),
              owner,
            ) ?? Effect.void
          ).pipe(
            Effect.andThen(
              Effect.raceFirst(
                ticket.run(
                  (activity?.presenting(id) ?? Effect.void).pipe(
                    Effect.andThen(host(request, owner)),
                  ),
                ),
                Deferred.await(cancel).pipe(Effect.as({ action: "cancel" } as const)),
              ),
            ),
            Effect.flatMap((value) => {
              const outcome = validateFormOutcome(request, value);
              return outcome
                ? Effect.succeed(outcome)
                : Effect.fail(
                    new AskUserValidationError({ message: "Invalid owned form answer." }),
                  );
            }),
          ),
        ).pipe(
          Effect.onExit(
            (exit) =>
              activity?.settled(
                id,
                Exit.isSuccess(exit)
                  ? exit.value.action === "accept"
                    ? "submitted"
                    : "cancelled"
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
});
