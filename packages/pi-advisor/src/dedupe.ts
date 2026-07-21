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
export interface AdvisorFindingDedupeState {
  readonly capacity: number;
  readonly scope?: string;
  readonly seen: Readonly<Record<string, AdvisorSeverity>>;
  readonly order: readonly string[];
}

export const emptyAdvisorFindingDedupe = (
  capacity = DEFAULT_FINDING_HISTORY_CAPACITY,
): AdvisorFindingDedupeState => ({
  capacity: Math.max(1, capacity),
  seen: {},
  order: [],
});

export const filterAdvisorFindingsWithRollback = (
  initial: AdvisorFindingDedupeState,
  findings: readonly AdvisorFinding[],
  scope = "default",
): {
  readonly state: AdvisorFindingDedupeState;
  readonly findings: AdvisorFinding[];
  readonly suppressed: number;
  readonly rollback: AdvisorFindingDedupeRollback;
} => {
  const state =
    scope === initial.scope ? initial : { ...emptyAdvisorFindingDedupe(initial.capacity), scope };
  const seen: Record<string, AdvisorSeverity> = { ...state.seen };
  const order = [...state.order];
  const accepted: AdvisorFinding[] = [];
  const entries: AdvisorFindingDedupeRollbackEntry[] = [];
  let suppressed = 0;
  for (const finding of findings) {
    const key = normalizeAdvisorFinding(finding);
    const previous = seen[key];
    if (
      !key ||
      (previous !== undefined && SEVERITY_RANK[previous] >= SEVERITY_RANK[finding.severity])
    ) {
      suppressed += 1;
      continue;
    }
    const entry: AdvisorFindingDedupeRollbackEntry = {
      key,
      ...(previous === undefined ? {} : { previous }),
      wasNew: previous === undefined,
      evicted: [],
    };
    if (previous === undefined) order.push(key);
    seen[key] = finding.severity;
    accepted.push(finding);
    while (order.length > state.capacity) {
      const stale = order.shift();
      if (stale === undefined) continue;
      const severity = seen[stale];
      if (severity) entry.evicted.push({ key: stale, severity });
      delete seen[stale];
    }
    entries.push(entry);
  }
  return {
    state: { capacity: state.capacity, scope, seen, order },
    findings: accepted,
    suppressed,
    rollback: { scope, entries },
  };
};

export const rollbackAdvisorFindingDedupe = (
  state: AdvisorFindingDedupeState,
  token: AdvisorFindingDedupeRollback,
): AdvisorFindingDedupeState => {
  if (token.scope !== state.scope) return state;
  const seen: Record<string, AdvisorSeverity> = { ...state.seen };
  const order = [...state.order];
  for (const entry of [...token.entries].reverse()) {
    if (entry.wasNew) {
      delete seen[entry.key];
      const index = order.lastIndexOf(entry.key);
      if (index >= 0) order.splice(index, 1);
    } else if (entry.previous) seen[entry.key] = entry.previous;
    for (const evicted of [...entry.evicted].reverse()) {
      seen[evicted.key] = evicted.severity;
      if (!order.includes(evicted.key)) order.unshift(evicted.key);
    }
  }
  return { ...state, seen, order };
};

/** Compatibility facade for external callers; application state uses the reducers above. */
export class AdvisorFindingDedupe {
  #state: AdvisorFindingDedupeState;
  constructor(capacity = DEFAULT_FINDING_HISTORY_CAPACITY) {
    this.#state = emptyAdvisorFindingDedupe(capacity);
  }
  filter(findings: readonly AdvisorFinding[], scope = "default") {
    const {
      rollback: _rollback,
      state,
      ...result
    } = filterAdvisorFindingsWithRollback(this.#state, findings, scope);
    this.#state = state;
    return result;
  }
  filterWithRollback(findings: readonly AdvisorFinding[], scope = "default") {
    const result = filterAdvisorFindingsWithRollback(this.#state, findings, scope);
    this.#state = result.state;
    const { state: _state, ...publicResult } = result;
    return publicResult;
  }
  rollback(token: AdvisorFindingDedupeRollback): void {
    this.#state = rollbackAdvisorFindingDedupe(this.#state, token);
  }
  reset(): void {
    this.#state = emptyAdvisorFindingDedupe(this.#state.capacity);
  }
}
