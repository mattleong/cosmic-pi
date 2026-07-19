import type { AdvisorSeverity } from "./review.ts";

export const MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST = 2;
export interface AdvisorInterventionBudgetSnapshot {
  delivered: number;
  highestSeverity?: "concern" | "blocker";
  correctionUsed: boolean;
}

export function sanitizeInterventionBudgetSnapshot(
  snapshot: Partial<AdvisorInterventionBudgetSnapshot> | undefined,
): AdvisorInterventionBudgetSnapshot {
  const delivered = snapshot?.delivered;
  return {
    delivered:
      typeof delivered === "number" && Number.isSafeInteger(delivered)
        ? Math.max(0, Math.min(MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST, delivered))
        : 0,
    ...(snapshot?.highestSeverity === "concern" || snapshot?.highestSeverity === "blocker"
      ? { highestSeverity: snapshot.highestSeverity }
      : {}),
    correctionUsed: snapshot?.correctionUsed === true,
  };
}

export class AdvisorInterventionBudget {
  #delivered = 0;
  #highestSeverity: "concern" | "blocker" | undefined;
  #correctionUsed = false;

  get snapshot(): AdvisorInterventionBudgetSnapshot {
    return {
      delivered: this.#delivered,
      highestSeverity: this.#highestSeverity,
      correctionUsed: this.#correctionUsed,
    };
  }

  canDeliver(severity: AdvisorSeverity): boolean {
    if (severity === "nit" || this.#delivered >= MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST)
      return false;
    if (!this.#highestSeverity) return true;
    return rank(severity) > rank(this.#highestSeverity);
  }

  canCorrect(): boolean {
    return !this.#correctionUsed;
  }

  commit(severity: AdvisorSeverity, correction: boolean): void {
    if (severity === "nit") return;
    this.#delivered = Math.min(MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST, this.#delivered + 1);
    if (!this.#highestSeverity || rank(severity) > rank(this.#highestSeverity)) {
      this.#highestSeverity = severity;
    }
    if (correction) this.#correctionUsed = true;
  }

  restore(snapshot: Partial<AdvisorInterventionBudgetSnapshot> | undefined): void {
    const sanitized = sanitizeInterventionBudgetSnapshot(snapshot);
    this.#delivered = sanitized.delivered;
    this.#highestSeverity = sanitized.highestSeverity;
    this.#correctionUsed = sanitized.correctionUsed;
  }

  reset(): void {
    this.restore(undefined);
  }
}

function rank(severity: AdvisorSeverity): number {
  return severity === "blocker" ? 2 : severity === "concern" ? 1 : 0;
}
