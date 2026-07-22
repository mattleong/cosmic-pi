/** Shared eligibility/clearing transitions for provider usage projections. */

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
