import * as MutableRef from "effect/MutableRef";
import { freezeSnapshot } from "./projection.ts";

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

export interface UsageEligibilityStatusTexts {
  readonly hiddenStatusText: string;
  readonly unavailableStatusText?: string;
}

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

export const makeFrozenUsageProjection = <Projection>(
  initialProjection: () => Projection,
): MutableRef.MutableRef<Projection> => MutableRef.make(freezeSnapshot(initialProjection()));

export const resetFrozenUsageProjection = <Projection>(
  projection: MutableRef.MutableRef<Projection>,
  initialProjection: () => Projection,
): void => {
  MutableRef.set(projection, freezeSnapshot(initialProjection()));
};
