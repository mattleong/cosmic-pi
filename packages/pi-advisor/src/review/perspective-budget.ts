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

/** Compatibility facade. New application code stores the immutable state directly. */
export class AdvisorPerspectiveBudget {
  #state = emptyAdvisorPerspectiveBudget();
  select(suggestions: readonly AdvisorSuggestion[]): AdvisorSuggestion | undefined {
    return selectAdvisorPerspective(this.#state, suggestions);
  }
  commit(suggestion: AdvisorSuggestion): void {
    this.#state = commitAdvisorPerspective(this.#state, suggestion);
  }
  reset(): void {
    this.#state = emptyAdvisorPerspectiveBudget();
  }
  get count(): number {
    return this.#state.delivered;
  }
}
