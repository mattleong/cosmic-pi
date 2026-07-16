import type { AdvisorFinding } from "./review.ts";

const DEFAULT_FINDING_HISTORY_CAPACITY = 512;

export function normalizeAdvisorFinding(finding: AdvisorFinding): string {
  return `${finding.category}\n${finding.issue}\n${finding.recommendation}`
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class AdvisorFindingDedupe {
  readonly #capacity: number;
  readonly #seen = new Set<string>();
  readonly #seenOrder: string[] = [];
  #scope: string | undefined;

  constructor(capacity = DEFAULT_FINDING_HISTORY_CAPACITY) {
    this.#capacity = Math.max(1, capacity);
  }

  filter(
    findings: readonly AdvisorFinding[],
    scope = "default",
  ): {
    findings: AdvisorFinding[];
    suppressed: number;
  } {
    if (scope !== this.#scope) {
      this.#seen.clear();
      this.#seenOrder.length = 0;
      this.#scope = scope;
    }
    const accepted: AdvisorFinding[] = [];
    let suppressed = 0;
    for (const finding of findings) {
      const key = normalizeAdvisorFinding(finding);
      if (!key || this.#seen.has(key)) {
        suppressed += 1;
        continue;
      }
      this.#seen.add(key);
      this.#seenOrder.push(key);
      accepted.push(finding);
      if (this.#seenOrder.length > this.#capacity) {
        const stale = this.#seenOrder.shift();
        if (stale !== undefined) this.#seen.delete(stale);
      }
    }
    return { findings: accepted, suppressed };
  }

  reset(): void {
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#scope = undefined;
  }
}
