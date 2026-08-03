import type { AdvisorSeverity } from "./schema.ts";

export const ADVISOR_IMMUNITY_COMPLETED_TURNS = 3;

export type AdvisorParentState = "active" | "idle" | "final" | "aborting";
export type AdvisorRoute =
  | "silent"
  | "push-direct"
  | "steer-live"
  | "abort-recover"
  | "trigger-correction";

export interface AdvisorRoutingInput {
  severity: AdvisorSeverity;
  parentState: AdvisorParentState;
  immunityActive: boolean;
  cancellationLatched: boolean;
  /** Strong local evidence produced during this exact, still-current parent turn. */
  sameTurnStrongSignal?: boolean;
  /** False while any main-agent tool call is executing. */
  abortSafe?: boolean;
}

/** Pure delivery policy. It never infers safety from elapsed time or model severity alone. */
export function routeAdvisorFinding(input: AdvisorRoutingInput): AdvisorRoute {
  // Automatic findings are either delivered immediately or dropped. Never
  // attach stale advice to a later user prompt.
  if (input.cancellationLatched || input.parentState === "aborting") return "silent";
  if (input.severity === "concern" && input.immunityActive) return "silent";

  if (input.parentState === "active") {
    if (
      input.severity === "blocker" &&
      input.sameTurnStrongSignal === true &&
      input.abortSafe === true
    ) {
      return "abort-recover";
    }
    return "steer-live";
  }

  return "trigger-correction";
}

export interface AdvisorRoutingStateSnapshot {
  completedPrimaryTurns: number;
  immunityUntilCompletedTurn: number;
  cancellationLatched: boolean;
}

export const emptyAdvisorRoutingState = (): AdvisorRoutingStateSnapshot => ({
  completedPrimaryTurns: 0,
  immunityUntilCompletedTurn: 0,
  cancellationLatched: false,
});

export const sanitizeAdvisorRoutingState = (
  snapshot: Partial<AdvisorRoutingStateSnapshot> | undefined,
): AdvisorRoutingStateSnapshot => ({
  completedPrimaryTurns: nonNegativeInteger(snapshot?.completedPrimaryTurns),
  immunityUntilCompletedTurn: nonNegativeInteger(snapshot?.immunityUntilCompletedTurn),
  cancellationLatched: snapshot?.cancellationLatched === true,
});

export const isAdvisorImmunityActive = (state: AdvisorRoutingStateSnapshot): boolean =>
  state.immunityUntilCompletedTurn > 0 &&
  state.completedPrimaryTurns <= state.immunityUntilCompletedTurn;

export const completeAdvisorPrimaryTurn = (
  state: AdvisorRoutingStateSnapshot,
): AdvisorRoutingStateSnapshot => ({
  ...state,
  completedPrimaryTurns: state.completedPrimaryTurns + 1,
});

export const armAdvisorInterruption = (
  state: AdvisorRoutingStateSnapshot,
): AdvisorRoutingStateSnapshot => ({
  ...state,
  immunityUntilCompletedTurn: state.completedPrimaryTurns + ADVISOR_IMMUNITY_COMPLETED_TURNS,
});

export const latchAdvisorCancellation = (
  state: AdvisorRoutingStateSnapshot,
): AdvisorRoutingStateSnapshot => ({ ...state, cancellationLatched: true });

export const clearAdvisorCancellation = (
  state: AdvisorRoutingStateSnapshot,
): AdvisorRoutingStateSnapshot => ({ ...state, cancellationLatched: false });

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
