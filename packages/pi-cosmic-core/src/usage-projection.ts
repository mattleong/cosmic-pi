/** Shared eligibility/clearing transitions for provider usage projections. */
import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot } from "./projection.ts";

/**
 * Common shape of a provider usage projection. Provider projections extend this with
 * provider-specific identity fields (for example team or account identifiers).
 */
export interface UsageProjectionBase<Resolved, Snapshot> {
  readonly config: Resolved | undefined;
  readonly eligible: boolean;
  readonly snapshot: Snapshot | undefined;
  readonly statusLine: string | undefined;
  readonly statusText: string;
  readonly error: string | undefined;
  readonly lastFetchAt: number | undefined;
  readonly updatedAt: number | undefined;
  readonly authPath: string | undefined;
  readonly authFound: boolean;
}

/** Initial value for the shared usage projection fields. */
export const initialUsageProjection = <Resolved, Snapshot>(): UsageProjectionBase<
  Resolved,
  Snapshot
> => ({
  config: undefined,
  eligible: false,
  snapshot: undefined,
  statusLine: undefined,
  statusText: "Usage unavailable",
  error: undefined,
  lastFetchAt: undefined,
  updatedAt: undefined,
  authPath: undefined,
  authFound: false,
});

type UsageVisibilityFields = {
  readonly eligible: boolean;
  readonly snapshot: unknown;
  readonly statusLine: string | undefined;
  readonly error: string | undefined;
  readonly updatedAt: number | undefined;
  readonly statusText: string;
};

/** Status-text overrides accepted alongside an eligibility decision. */
export interface UsageEligibilityStatusTexts {
  readonly hiddenStatusText: string;
  readonly unavailableStatusText?: string;
}

/**
 * Apply eligibility to a usage projection.
 * When hidden or cleared, drops status/error/snapshot fields that must not linger on screen.
 */
export function withUsageEligibility<T extends UsageVisibilityFields>(
  current: T,
  eligible: boolean,
  clearUsage: boolean,
  options: UsageEligibilityStatusTexts,
): T {
  const unavailable = options.unavailableStatusText ?? "Usage unavailable";
  const statusText = eligible ? unavailable : options.hiddenStatusText;
  return {
    ...current,
    eligible,
    ...(clearUsage
      ? {
          snapshot: undefined,
          statusLine: undefined,
          error: undefined,
          updatedAt: undefined,
          statusText,
        }
      : eligible
        ? {}
        : { statusLine: undefined, error: undefined, statusText }),
  };
}

/**
 * Frozen-projection ref factory shared by provider usage controllers: one mutable ref holding a
 * deeply frozen copy of the provider's initial projection.
 */
export const makeFrozenUsageProjection = <Projection>(
  initialProjection: () => Projection,
): MutableRef.MutableRef<Projection> => MutableRef.make(freezeSnapshot(initialProjection()));

/** Reset companion of `makeFrozenUsageProjection`; rebuilds and republishes the frozen snapshot. */
export const resetFrozenUsageProjection = <Projection>(
  projection: MutableRef.MutableRef<Projection>,
  initialProjection: () => Projection,
): void => {
  MutableRef.set(projection, freezeSnapshot(initialProjection()));
};

/** Provider-specific eligibility decision for the current host context. */
interface UsageEligibilityDecision {
  readonly eligible: boolean;
  readonly clearUsage: boolean;
  /** Overrides for the hidden/unavailable status texts; defaults apply when omitted. */
  readonly statusTexts?: Partial<UsageEligibilityStatusTexts>;
}

/**
 * Serialized-context synchronization shell: providers supply only the eligibility decision;
 * this applies `withUsageEligibility` and publishes the frozen snapshot in one step.
 */
export function synchronizeUsageProjectionContext<Projection extends UsageVisibilityFields>(
  projection: MutableRef.MutableRef<Projection>,
  evaluateEligibility: (state: Projection) => UsageEligibilityDecision,
): void {
  const current = MutableRef.get(projection);
  const decision = evaluateEligibility(current);
  const texts = { hiddenStatusText: "Usage hidden", ...decision.statusTexts };
  MutableRef.set(
    projection,
    freezeSnapshot(withUsageEligibility(current, decision.eligible, decision.clearUsage, texts)),
  );
}
