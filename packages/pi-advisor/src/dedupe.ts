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

export interface AdvisorFindingDedupeRollbackEntry {
  key: string;
  previous?: AdvisorSeverity;
  wasNew: boolean;
  evicted: Array<{ key: string; severity: AdvisorSeverity }>;
}

export interface AdvisorFindingDedupeRollback {
  scope: string;
  entries: AdvisorFindingDedupeRollbackEntry[];
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
    const { rollback: _rollback, ...result } = this.filterWithRollback(findings, scope);
    return result;
  }

  filterWithRollback(
    findings: readonly AdvisorFinding[],
    scope = "default",
  ): {
    findings: AdvisorFinding[];
    suppressed: number;
    rollback: AdvisorFindingDedupeRollback;
  } {
    if (scope !== this.#scope) {
      this.reset();
      this.#scope = scope;
    }
    const accepted: AdvisorFinding[] = [];
    const entries: AdvisorFindingDedupeRollbackEntry[] = [];
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
      const entry: AdvisorFindingDedupeRollbackEntry = {
        key,
        previous,
        wasNew: previous === undefined,
        evicted: [],
      };
      if (previous === undefined) this.#seenOrder.push(key);
      this.#seen.set(key, finding.severity);
      accepted.push(finding);
      while (this.#seenOrder.length > this.#capacity) {
        const stale = this.#seenOrder.shift();
        if (stale === undefined) continue;
        const severity = this.#seen.get(stale);
        if (severity) entry.evicted.push({ key: stale, severity });
        this.#seen.delete(stale);
      }
      entries.push(entry);
    }
    return { findings: accepted, suppressed, rollback: { scope, entries } };
  }

  rollback(token: AdvisorFindingDedupeRollback): void {
    if (token.scope !== this.#scope) return;
    for (const entry of [...token.entries].reverse()) {
      if (entry.wasNew) {
        this.#seen.delete(entry.key);
        const index = this.#seenOrder.lastIndexOf(entry.key);
        if (index >= 0) this.#seenOrder.splice(index, 1);
      } else if (entry.previous) {
        this.#seen.set(entry.key, entry.previous);
      }
      for (const evicted of [...entry.evicted].reverse()) {
        this.#seen.set(evicted.key, evicted.severity);
        if (!this.#seenOrder.includes(evicted.key)) this.#seenOrder.unshift(evicted.key);
      }
    }
  }

  reset(): void {
    this.#seen.clear();
    this.#seenOrder.length = 0;
    this.#scope = undefined;
  }
}
