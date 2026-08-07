import * as Effect from "effect/Effect";
import type { SubagentNotFoundError } from "../src/run/errors.ts";
import type { SubagentRunObservation, SubagentServiceShape } from "../src/run/service.ts";

type ObservationMethods = Pick<
  SubagentServiceShape,
  | "startSessionOwned"
  | "withAwaitTerminalObservations"
  | "withStatusObservations"
  | "consumeCompletions"
>;

export type SubagentServiceDoubleInput = Omit<SubagentServiceShape, keyof ObservationMethods> &
  Partial<ObservationMethods> & {
    /** Optional per-run observation seed used to derive `withStatusObservations`. */
    readonly observeStatus?: (
      id: string,
    ) => Effect.Effect<SubagentRunObservation, SubagentNotFoundError>;
  };

/**
 * Completes a `SubagentServiceShape` test double.
 *
 * The observation methods are required on the production shape. Doubles that only care about the
 * plain run methods get faithful derivations here instead of the tool re-implementing fallbacks.
 */
export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceShape {
  const startSessionOwned: SubagentServiceShape["startSessionOwned"] =
    base.startSessionOwned ?? base.start;
  const observeStatus =
    base.observeStatus ??
    ((id: string) => base.status(id).pipe(Effect.map((run): SubagentRunObservation => ({ run }))));
  const consumeCompletions: SubagentServiceShape["consumeCompletions"] =
    base.consumeCompletions ?? (() => Effect.void);
  const withStatusObservations: SubagentServiceShape["withStatusObservations"] =
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
  const withAwaitTerminalObservations: SubagentServiceShape["withAwaitTerminalObservations"] =
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
