import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot, ProjectionError } from "pi-cosmic-core";
import type { ResolvedAdvisorConfig } from "./config.ts";
import type { AdvisorSessionMetrics } from "./settings.ts";

export interface AdvisorControllerSnapshot {
  readonly config: ResolvedAdvisorConfig;
  readonly metrics: AdvisorSessionMetrics;
  readonly paused: boolean;
  readonly started: boolean;
}

export interface AdvisorProjection {
  readonly getSnapshot: () => AdvisorControllerSnapshot;
  /** Publishes a cloned, deeply frozen projection at a mandatory synchronous Pi boundary. */
  readonly replaceNow: (snapshot: AdvisorControllerSnapshot) => void;
  readonly replace: (snapshot: AdvisorControllerSnapshot) => Effect.Effect<void, ProjectionError>;
}

/** Plain synchronous projection; authoritative application state remains in the controller domain. */
export const makeAdvisorProjection = (
  initial: AdvisorControllerSnapshot,
): Effect.Effect<AdvisorProjection> =>
  Effect.sync(() => {
    const snapshot = MutableRef.make(freezeSnapshot(initial));
    const replaceNow = (next: AdvisorControllerSnapshot): void => {
      MutableRef.set(snapshot, freezeSnapshot(next));
    };
    return {
      getSnapshot: () => MutableRef.get(snapshot),
      replaceNow,
      replace: (next) =>
        Effect.try({
          try: () => replaceNow(next),
          catch: (error) =>
            error instanceof ProjectionError
              ? error
              : new ProjectionError({ path: "$", message: "Unable to publish Advisor snapshot." }),
        }),
    };
  });
