import { canonicalAdvisorFindingFingerprint, type AdvisorSuggestion } from "./review.ts";

export const MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST = 2;

/** A small request-scoped budget for optional, non-interrupting perspective guidance. */
export class AdvisorPerspectiveBudget {
  private delivered = 0;
  private readonly fingerprints = new Set<string>();

  select(suggestions: readonly AdvisorSuggestion[]): AdvisorSuggestion | undefined {
    if (this.delivered >= MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST) return undefined;
    return suggestions.find((suggestion) => {
      const fingerprint = canonicalAdvisorFindingFingerprint(suggestion.fingerprint ?? "");
      return Boolean(fingerprint) && !this.fingerprints.has(fingerprint);
    });
  }

  commit(suggestion: AdvisorSuggestion): void {
    const fingerprint = canonicalAdvisorFindingFingerprint(suggestion.fingerprint ?? "");
    if (!fingerprint || this.fingerprints.has(fingerprint)) return;
    this.fingerprints.add(fingerprint);
    this.delivered = Math.min(MAX_AUTOMATIC_PERSPECTIVES_PER_REQUEST, this.delivered + 1);
  }

  reset(): void {
    this.delivered = 0;
    this.fingerprints.clear();
  }

  get count(): number {
    return this.delivered;
  }
}
