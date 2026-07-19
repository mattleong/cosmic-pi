import type { AdvisorSeverity } from "./review.ts";

export const MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST = 2;
export interface AdvisorInterventionBudgetSnapshot {
  delivered: number;
  highestSeverity?: "concern" | "blocker";
  correctionUsed: boolean;
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
    this.#delivered = Math.max(
      0,
      Math.min(
        MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST,
        Number.isSafeInteger(snapshot?.delivered) ? Number(snapshot?.delivered) : 0,
      ),
    );
    this.#highestSeverity =
      snapshot?.highestSeverity === "concern" || snapshot?.highestSeverity === "blocker"
        ? snapshot.highestSeverity
        : undefined;
    this.#correctionUsed = snapshot?.correctionUsed === true;
  }

  reset(): void {
    this.restore(undefined);
  }
}

function rank(severity: AdvisorSeverity): number {
  return severity === "blocker" ? 2 : severity === "concern" ? 1 : 0;
}
