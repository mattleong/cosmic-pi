import type { AdvisorFinding, AdvisorSeverity } from "./review.ts";

const DEFAULT_FINDING_HISTORY_CAPACITY = 512;
const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 0, concern: 1, blocker: 2 };

export function normalizeAdvisorFinding(finding: AdvisorFinding): string {
  return `${finding.category}\n${finding.issue}\n${finding.recommendation}`
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Suppress equal/lower repeats while allowing a genuine severity escalation. */
export class AdvisorFindingDedupe {
  readonly #capacity: number;
  readonly #seen = new Map<string, AdvisorSeverity>();
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
      this.reset();
      this.#scope = scope;
    }
    const accepted: AdvisorFinding[] = [];
    let suppressed = 0;
    for (const finding of findings) {
      const key = normalizeAdvisorFinding(finding);
      const previous = this.#seen.get(key);
      if (
        !key ||
        (previous !== undefined && SEVERITY_RANK[previous] >= SEVERITY_RANK[finding.severity])
      ) {
        suppressed += 1;
        continue;
      }
      if (previous === undefined) this.#seenOrder.push(key);
      this.#seen.set(key, finding.severity);
      accepted.push(finding);
      while (this.#seenOrder.length > this.#capacity) {
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
