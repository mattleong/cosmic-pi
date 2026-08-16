import * as Predicate from "effect/Predicate";

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
  return (() => {
    const objectPart563_0 = {
      delivered:
        Predicate.isNumber(delivered) && Number.isSafeInteger(delivered)
          ? Math.max(0, Math.min(MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST, delivered))
          : 0,
    };
    const objectPart563_1 =
      snapshot?.highestSeverity === "concern" || snapshot?.highestSeverity === "blocker"
        ? { ...objectPart563_0, highestSeverity: snapshot.highestSeverity }
        : objectPart563_0;
    const objectPart563_2 = {
      ...objectPart563_1,
      correctionUsed: snapshot?.correctionUsed === true,
    };
    return objectPart563_2;
  })();
}

export const emptyAdvisorInterventionBudget = (): AdvisorInterventionBudgetSnapshot =>
  sanitizeInterventionBudgetSnapshot(undefined);

export const canDeliverAdvisorIntervention = (
  state: AdvisorInterventionBudgetSnapshot,
  severity: AdvisorSeverity,
): boolean => {
  if (state.delivered >= MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST) return false;
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
