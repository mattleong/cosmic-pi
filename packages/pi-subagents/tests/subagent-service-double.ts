import * as Effect from "effect/Effect";
import type { SubagentRunObservation, SubagentServiceShape } from "../src/run/service.ts";

type ObservationMethods = Pick<
  SubagentServiceShape,
  | "awaitTerminalObserved"
  | "withAwaitTerminalObservations"
  | "observeStatus"
  | "withStatusObservations"
  | "consumeCompletions"
>;

export type SubagentServiceDoubleInput = Omit<SubagentServiceShape, keyof ObservationMethods> &
  Partial<ObservationMethods>;

/**
 * Completes a `SubagentServiceShape` test double.
 *
 * The observation methods are required on the production shape. Doubles that only care about the
 * plain run methods get faithful derivations here instead of the tool re-implementing fallbacks.
 */
export function subagentServiceDouble(base: SubagentServiceDoubleInput): SubagentServiceShape {
  const observeStatus: SubagentServiceShape["observeStatus"] =
    base.observeStatus ?? ((id) => base.status(id).pipe(Effect.map((run) => ({ run }))));
  const consumeCompletions: SubagentServiceShape["consumeCompletions"] =
    base.consumeCompletions ?? (() => Effect.void);
  const awaitTerminalObserved: SubagentServiceShape["awaitTerminalObserved"] =
    base.awaitTerminalObserved ??
    ((ids, until, onUpdate) =>
      base
        .awaitTerminal(ids, until, onUpdate)
        .pipe(Effect.map((runs) => runs.map((run): SubagentRunObservation => ({ run })))));
  const withStatusObservations: SubagentServiceShape["withStatusObservations"] =
    base.withStatusObservations ??
    ((ids, use) =>
      Effect.forEach(ids, observeStatus, { concurrency: 8 }).pipe(
        Effect.flatMap((observations) => use(observations)),
      ));
  const withAwaitTerminalObservations: SubagentServiceShape["withAwaitTerminalObservations"] =
    base.withAwaitTerminalObservations ??
    ((ids, until, onUpdate, use) =>
      awaitTerminalObserved(ids, until, onUpdate).pipe(
        Effect.flatMap((observations) => use(observations)),
      ));
  return {
    ...base,
    observeStatus,
    consumeCompletions,
    awaitTerminalObserved,
    withStatusObservations,
    withAwaitTerminalObservations,
  };
}
