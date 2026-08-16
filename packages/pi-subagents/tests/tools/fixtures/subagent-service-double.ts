import * as Effect from "effect/Effect";
import type { SubagentNotFoundError } from "../../../src/run/errors.ts";
import type { SubagentRunObservation, SubagentServiceContract } from "../../../src/run/service.ts";

type ObservationMethods = Pick<
  SubagentServiceContract,
  | "startSessionOwned"
  | "withAwaitTerminalObservations"
  | "withStatusObservations"
  | "consumeCompletions"
>;

export type SubagentServiceDoubleInput = Omit<SubagentServiceContract, keyof ObservationMethods> &
  Partial<ObservationMethods> & {
    /** Optional per-run observation seed used to derive `withStatusObservations`. */
    readonly observeStatus?: (
      id: string,
    ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
  };

/**
 * Completes a `SubagentServiceContract` test double.
 *
 * The observation methods are required on the production shape. Doubles that only care about the
 * plain run methods get faithful derivations here instead of the tool re-implementing fallbacks.
 */
export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceContract {
  const startSessionOwned: SubagentServiceContract["startSessionOwned"] =
    base.startSessionOwned ?? base.start;
  const observeStatus =
    base.observeStatus ??
    ((id: string) => base.status(id).pipe(Effect.map((run): SubagentRunObservation => ({ run }))));
  const consumeCompletions: SubagentServiceContract["consumeCompletions"] =
    base.consumeCompletions ?? (() => Effect.void);
  const withStatusObservations: SubagentServiceContract["withStatusObservations"] =
    base.withStatusObservations ??
    ((ids, use) =>
      Effect.forEach(
        ids,
        (id) =>
          observeStatus(id).pipe(
            Effect.match({
              onFailure: () => ({ missingId: id }) as const,
              onSuccess: (observation) => ({ observation }) as const,
            }),
          ),
        { concurrency: 8 },
      ).pipe(
        Effect.flatMap((outcomes) =>
          use({
            observations: outcomes.flatMap((outcome) =>
              "observation" in outcome ? [outcome.observation] : [],
            ),
            missingIds: outcomes.flatMap((outcome) =>
              "missingId" in outcome ? [outcome.missingId] : [],
            ),
          }),
        ),
      ));
  const withAwaitTerminalObservations: SubagentServiceContract["withAwaitTerminalObservations"] =
    base.withAwaitTerminalObservations ??
    ((ids, until, onUpdate, use) =>
      base
        .awaitTerminal(ids, until, onUpdate)
        .pipe(Effect.flatMap((runs) => use(runs.map((run): SubagentRunObservation => ({ run }))))));
  return {
    ...base,
    startSessionOwned,
    consumeCompletions,
    withStatusObservations,
    withAwaitTerminalObservations,
  };
}
