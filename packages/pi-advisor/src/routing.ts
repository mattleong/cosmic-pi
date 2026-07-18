import type { AdvisorReviewPolicy } from "./config.ts";
import type { AdvisorSeverity } from "./review.ts";

export const ADVISOR_IMMUNITY_COMPLETED_TURNS = 3;

export type AdvisorParentState = "active" | "idle" | "final" | "aborting";
export type AdvisorRoute =
  | "silent"
  | "preserve-next-turn"
  | "steer-live"
  | "abort-recover"
  | "trigger-correction";

export interface AdvisorRoutingInput {
  severity: AdvisorSeverity;
  policy: AdvisorReviewPolicy;
  parentState: AdvisorParentState;
  immunityActive: boolean;
  cancellationLatched: boolean;
  /** Explicit scheduling such as /advisor once; it never changes delivery policy. */
  manualAction?: boolean;
  /** Strong local evidence produced during this exact, still-current parent turn. */
  sameTurnStrongSignal?: boolean;
  /** False while any main-agent tool call is executing. */
  abortSafe?: boolean;
}

/** Pure delivery policy. It never infers safety from elapsed time or model severity alone. */
export function routeAdvisorFinding(input: AdvisorRoutingInput): AdvisorRoute {
  if (input.severity === "nit") return "silent";

  if (input.policy === "advisory") return "preserve-next-turn";
  if (input.severity === "concern" && input.policy === "guardrail") {
    return "preserve-next-turn";
  }

  if (input.cancellationLatched || input.parentState === "aborting") {
    return "preserve-next-turn";
  }
  if (input.severity === "concern" && input.immunityActive) {
    return "preserve-next-turn";
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

/** Mutable counter holder; routing itself remains the pure function above. */
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
    this.completed = nonNegativeInteger(snapshot.completedPrimaryTurns);
    this.immunityUntil = nonNegativeInteger(snapshot.immunityUntilCompletedTurn);
    this.cancelled = snapshot.cancellationLatched === true;
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
