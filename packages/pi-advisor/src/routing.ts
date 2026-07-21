import type { AdvisorReviewPolicy } from "./config.ts";
import type { AdvisorSeverity } from "./review.ts";

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
  policy: AdvisorReviewPolicy;
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
  if (input.severity === "nit") return "silent";

  // Automatic findings are either delivered immediately or dropped. Never
  // attach stale advice to a later user prompt.
  if (input.cancellationLatched || input.parentState === "aborting") return "silent";
  if (input.severity === "concern" && input.immunityActive) return "silent";

  if (input.policy === "advisory") {
    return input.parentState === "active" ? "push-direct" : "silent";
  }
  if (input.severity === "concern" && input.policy === "guardrail") {
    return input.parentState === "active" ? "push-direct" : "silent";
  }

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

/** Compatibility facade. New application code stores the immutable snapshot directly. */
export class AdvisorRoutingState {
  private completed = 0;
  private immunityUntil = 0;
  private cancelled = false;

  constructor(snapshot?: Partial<AdvisorRoutingStateSnapshot>) {
    if (snapshot) this.restore(snapshot);
  }

  get snapshot(): AdvisorRoutingStateSnapshot {
    return {
      completedPrimaryTurns: this.completed,
      immunityUntilCompletedTurn: this.immunityUntil,
      cancellationLatched: this.cancelled,
    };
  }

  get immunityActive(): boolean {
    return this.immunityUntil > 0 && this.completed <= this.immunityUntil;
  }

  get cancellationLatched(): boolean {
    return this.cancelled;
  }

  completePrimaryTurn(): void {
    this.completed += 1;
  }

  armInterruption(): void {
    this.immunityUntil = this.completed + ADVISOR_IMMUNITY_COMPLETED_TURNS;
  }

  latchCancellation(): void {
    this.cancelled = true;
  }

  clearCancellationForGenuineUserPrompt(): void {
    this.cancelled = false;
  }

  restore(snapshot: Partial<AdvisorRoutingStateSnapshot>): void {
    const state = sanitizeAdvisorRoutingState(snapshot);
    this.completed = state.completedPrimaryTurns;
    this.immunityUntil = state.immunityUntilCompletedTurn;
    this.cancelled = state.cancellationLatched;
  }

  reset(): void {
    this.completed = 0;
    this.immunityUntil = 0;
    this.cancelled = false;
  }
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
