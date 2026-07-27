import { canonicalAdvisorFindingFingerprint } from "./parse.ts";
import type { AdvisorSuggestion } from "./schema.ts";

export const MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST = 2;

export interface AdvisorPerspectiveBudgetState {
  readonly delivered: number;
  readonly fingerprints: readonly string[];
}

export const emptyAdvisorPerspectiveBudget = (): AdvisorPerspectiveBudgetState => ({
  delivered: 0,
  fingerprints: [],
});

export const selectAdvisorPerspective = (
  state: AdvisorPerspectiveBudgetState,
  suggestions: readonly AdvisorSuggestion[],
): AdvisorSuggestion | undefined => {
  if (state.delivered >= MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST) return undefined;
  const fingerprints = new Set(state.fingerprints);
  return suggestions.find((suggestion) => {
    const fingerprint = canonicalAdvisorFindingFingerprint(suggestion.fingerprint ?? "");
    return Boolean(fingerprint) && !fingerprints.has(fingerprint);
  });
};

export const commitAdvisorPerspective = (
  state: AdvisorPerspectiveBudgetState,
  suggestion: AdvisorSuggestion,
): AdvisorPerspectiveBudgetState => {
  const fingerprint = canonicalAdvisorFindingFingerprint(suggestion.fingerprint ?? "");
  if (!fingerprint || state.fingerprints.includes(fingerprint)) return state;
  return {
    delivered: Math.min(MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST, state.delivered + 1),
    fingerprints: [...state.fingerprints, fingerprint],
  };
};
