import { advisorSeverityRank, type AdvisorSeverity } from "./schema.ts";

export const MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST = 2;
export interface AdvisorInterventionBudgetSnapshot {
  readonly delivered: number;
  readonly highestSeverity?: "concern" | "blocker";
  readonly correctionUsed: boolean;
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

export const emptyAdvisorInterventionBudget = (): AdvisorInterventionBudgetSnapshot =>
  sanitizeInterventionBudgetSnapshot(undefined);

export const canDeliverAdvisorIntervention = (
  state: AdvisorInterventionBudgetSnapshot,
  severity: AdvisorSeverity,
): boolean => {
  if (severity === "nit" || state.delivered >= MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST)
    return false;
  return (
    state.highestSeverity === undefined ||
    advisorSeverityRank(severity) > advisorSeverityRank(state.highestSeverity)
  );
};

export const canCorrectAdvisorIntervention = (state: AdvisorInterventionBudgetSnapshot): boolean =>
  !state.correctionUsed;

export const commitAdvisorIntervention = (
  state: AdvisorInterventionBudgetSnapshot,
  severity: AdvisorSeverity,
  correction: boolean,
): AdvisorInterventionBudgetSnapshot => {
  if (severity === "nit") return state;
  const highestSeverity =
    !state.highestSeverity ||
    advisorSeverityRank(severity) > advisorSeverityRank(state.highestSeverity)
      ? severity
      : state.highestSeverity;
  return {
    delivered: Math.min(MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST, state.delivered + 1),
    highestSeverity,
    correctionUsed: state.correctionUsed || correction,
  };
};

/** Compatibility facade. New application code stores the immutable snapshot directly. */
export class AdvisorInterventionBudget {
  #state = emptyAdvisorInterventionBudget();
  get snapshot(): AdvisorInterventionBudgetSnapshot {
    return this.#state;
  }
  canDeliver(severity: AdvisorSeverity): boolean {
    return canDeliverAdvisorIntervention(this.#state, severity);
  }
  canCorrect(): boolean {
    return canCorrectAdvisorIntervention(this.#state);
  }
  commit(severity: AdvisorSeverity, correction: boolean): void {
    this.#state = commitAdvisorIntervention(this.#state, severity, correction);
  }
  restore(snapshot: Partial<AdvisorInterventionBudgetSnapshot> | undefined): void {
    this.#state = sanitizeInterventionBudgetSnapshot(snapshot);
  }
  reset(): void {
    this.#state = emptyAdvisorInterventionBudget();
  }
}
