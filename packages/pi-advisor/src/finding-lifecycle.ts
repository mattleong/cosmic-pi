import { createHash } from "node:crypto";
import { canonicalAdvisorFindingFingerprint } from "./review.ts";
import type {
  AdvisorFinding,
  AdvisorFindingCategory,
  AdvisorFindingStatus,
  AdvisorSeverity,
} from "./review.ts";
import { isRecord } from "./utils.ts";

export const MAX_FINDING_LIFECYCLE_RECORDS = 64;

export interface AdvisorFindingRecord {
  id: string;
  key: string;
  generation: number;
  category: AdvisorFindingCategory;
  severity: AdvisorSeverity;
  status: AdvisorFindingStatus;
  firstSeenTurn: number;
  lastSeenTurn: number;
}

export class AdvisorFindingLifecycle {
  readonly #records = new Map<string, AdvisorFindingRecord>();
  readonly #generations = new Map<string, number>();

  reconcile(
    findings: readonly AdvisorFinding[],
    options: { scope: string; completedTurn: number; complete: boolean },
  ): AdvisorFinding[] {
    const active = new Set<string>();
    const enriched = findings.map((finding) => {
      const semantic = normalizeSemanticFinding(finding);
      const key = semanticKey(options.scope, semantic);
      let generation = this.#generations.get(key) ?? 0;
      let id = advisorFindingId(key, generation);
      const previous = this.#records.get(id);
      if (previous?.status === "resolved" || previous?.status === "superseded") {
        generation += 1;
        this.#generations.set(key, generation);
        id = advisorFindingId(key, generation);
      }
      const record = this.#records.get(id) ?? {
        id,
        key,
        generation,
        category: finding.category,
        severity: finding.severity,
        status: "open" as const,
        firstSeenTurn: options.completedTurn,
        lastSeenTurn: options.completedTurn,
      };
      const previousSeverity = record.severity;
      if (
        record.status === "acknowledged" &&
        severityRank(finding.severity) > severityRank(previousSeverity)
      ) {
        record.status = "open";
      }
      record.category = finding.category;
      record.severity = finding.severity;
      record.lastSeenTurn = options.completedTurn;
      this.#records.set(id, record);
      active.add(id);
      return { ...finding, id, status: record.status };
    });
    if (options.complete) {
      for (const record of this.#records.values()) {
        if (
          (record.status === "open" || record.status === "acknowledged") &&
          !active.has(record.id)
        ) {
          record.status = "resolved";
          record.lastSeenTurn = options.completedTurn;
        }
      }
    }
    this.#trim();
    return enriched;
  }

  acknowledge(ids: readonly string[]): void {
    for (const id of ids) {
      const record = this.#records.get(id);
      if (record?.status === "open") record.status = "acknowledged";
    }
  }

  supersede(ids: readonly string[]): void {
    for (const id of ids) {
      const record = this.#records.get(id);
      if (record && (record.status === "open" || record.status === "acknowledged")) {
        record.status = "superseded";
      }
    }
  }

  snapshot(): AdvisorFindingRecord[] {
    return [...this.#records.values()].map((record) => ({ ...record }));
  }

  restore(records: readonly AdvisorFindingRecord[] | undefined): void {
    this.reset();
    for (const candidate of records?.slice(-MAX_FINDING_LIFECYCLE_RECORDS) ?? []) {
      if (!isValidAdvisorFindingRecord(candidate)) continue;
      const record = { ...candidate };
      this.#records.set(record.id, record);
      this.#generations.set(
        record.key,
        Math.max(record.generation, this.#generations.get(record.key) ?? 0),
      );
    }
  }

  counts(): Record<AdvisorFindingStatus, number> {
    const counts = { open: 0, acknowledged: 0, resolved: 0, superseded: 0 };
    for (const record of this.#records.values()) counts[record.status] += 1;
    return counts;
  }

  reset(): void {
    this.#records.clear();
    this.#generations.clear();
  }

  #trim(): void {
    if (this.#records.size <= MAX_FINDING_LIFECYCLE_RECORDS) return;
    const evictionOrder = [...this.#records.values()].sort((left, right) => {
      const terminalDifference = Number(isTerminal(right)) - Number(isTerminal(left));
      if (terminalDifference !== 0) return terminalDifference;
      return (
        left.lastSeenTurn - right.lastSeenTurn ||
        left.firstSeenTurn - right.firstSeenTurn ||
        left.id.localeCompare(right.id)
      );
    });
    for (const record of evictionOrder) {
      if (this.#records.size <= MAX_FINDING_LIFECYCLE_RECORDS) break;
      this.#records.delete(record.id);
    }
    const retainedKeys = new Set([...this.#records.values()].map((record) => record.key));
    for (const key of this.#generations.keys()) {
      if (!retainedKeys.has(key)) this.#generations.delete(key);
    }
  }
}

function normalizeSemanticFinding(finding: AdvisorFinding): string {
  return canonicalAdvisorFindingFingerprint(
    finding.fingerprint ?? `${finding.category} ${finding.issue} ${finding.recommendation}`,
  );
}

export function isValidAdvisorFindingRecord(value: unknown): value is AdvisorFindingRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    /^af_[a-f\d]{32}$/.test(value.id) &&
    typeof value.key === "string" &&
    /^[a-f\d]{64}$/.test(value.key) &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    (value.category === "intent" ||
      value.category === "correctness" ||
      value.category === "completeness" ||
      value.category === "evidence") &&
    (value.severity === "nit" || value.severity === "concern" || value.severity === "blocker") &&
    (value.status === "open" ||
      value.status === "acknowledged" ||
      value.status === "resolved" ||
      value.status === "superseded") &&
    typeof value.firstSeenTurn === "number" &&
    Number.isSafeInteger(value.firstSeenTurn) &&
    value.firstSeenTurn >= 0 &&
    typeof value.lastSeenTurn === "number" &&
    Number.isSafeInteger(value.lastSeenTurn) &&
    value.lastSeenTurn >= value.firstSeenTurn &&
    value.id === advisorFindingId(value.key, value.generation)
  );
}

function isTerminal(record: AdvisorFindingRecord): boolean {
  return record.status === "resolved" || record.status === "superseded";
}

function semanticKey(scope: string, semantic: string): string {
  return createHash("sha256").update(`${scope}\0${semantic}`).digest("hex");
}

function severityRank(severity: AdvisorSeverity): number {
  return severity === "blocker" ? 2 : severity === "concern" ? 1 : 0;
}

export function advisorFindingId(key: string, generation: number): string {
  return `af_${createHash("sha256").update(`${key}\0${generation}`).digest("hex").slice(0, 32)}`;
}
