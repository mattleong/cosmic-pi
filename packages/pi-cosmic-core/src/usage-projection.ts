/** Shared eligibility/clearing transitions for provider usage projections. */

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
  statusText: "Usage unavailable.",
  error: undefined,
  lastFetchAt: undefined,
  updatedAt: undefined,
  authPath: undefined,
  authFound: false,
});

export type UsageVisibilityFields = {
  readonly eligible: boolean;
  readonly snapshot: unknown;
  readonly statusLine: string | undefined;
  readonly error: string | undefined;
  readonly updatedAt: number | undefined;
  readonly statusText: string;
};

/**
 * Apply eligibility to a usage projection.
 * When hidden or cleared, drops status/error/snapshot fields that must not linger on screen.
 */
export function withUsageEligibility<T extends UsageVisibilityFields>(
  current: T,
  eligible: boolean,
  clearUsage: boolean,
  options: {
    readonly hiddenStatusText: string;
    readonly unavailableStatusText?: string;
  },
): T {
  const unavailable = options.unavailableStatusText ?? "Usage unavailable.";
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
