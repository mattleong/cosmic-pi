import * as Effect from "effect/Effect";
import { HerdrForkError } from "./errors.ts";

export const retainedPaneGuidance = (paneId: string): string =>
  `Pane ${paneId} was retained for manual inspection.`;

export const retainPaneFailure = (
  failure: HerdrForkError,
  paneId: string,
  guidance: string = retainedPaneGuidance(paneId),
): HerdrForkError => {
  if (failure.paneId === paneId) return failure;
  return new HerdrForkError({
    ...failure,
    paneId,
    message: failure.message.includes(guidance)
      ? failure.message
      : `${failure.message} ${guidance}`,
  });
};

/**
 * A successful split is deliberately retained rather than released. This region gives every
 * later failure the exact pane identity without changing its confirmed/uncertain outcome.
 */
export const withRetainedPane =
  (paneId: string, guidance?: string) =>
  <A>(effect: Effect.Effect<A, HerdrForkError>): Effect.Effect<A, HerdrForkError> =>
    effect.pipe(Effect.mapError((failure) => retainPaneFailure(failure, paneId, guidance)));
