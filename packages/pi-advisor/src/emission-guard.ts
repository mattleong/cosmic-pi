import { createHash } from "node:crypto";
import type { AdvisorReview, AdvisorSeverity } from "./review.ts";

export const MAX_EMISSION_HISTORY = 32;

export type EmissionSuppressionReason = "pass" | "content-free" | "duplicate" | "checkpoint-budget";

export interface AdvisorEmissionRollback {
  checkpointId: string;
  checkpointEvicted: string[];
  hash: string;
  previousSeverity?: AdvisorSeverity;
  wasNewHash: boolean;
  hashEvicted: Array<{ hash: string; severity: AdvisorSeverity }>;
}

export type AdvisorEmissionDecision =
  | {
      accepted: true;
      hash: string;
      severity: AdvisorSeverity;
      rollback: AdvisorEmissionRollback;
    }
  | { accepted: false; reason: EmissionSuppressionReason };

const SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 0, concern: 1, blocker: 2 };

/** Unicode/case/punctuation normalization shared by emission persistence and tests. */
export function normalizeEmissionContent(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function highestAdvisorSeverity(review: AdvisorReview): AdvisorSeverity | undefined {
  let highest: AdvisorSeverity | undefined;
  for (const finding of review.findings) {
    if (!highest || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest]) {
      highest = finding.severity;
    }
  }
  return highest;
}

export function isContentFreeAdvisorReview(review: AdvisorReview): boolean {
  if (review.verdict === "pass" || review.findings.length === 0) return true;
  const fields = review.findings.flatMap((finding) => [
    finding.issue,
    finding.evidence,
    finding.recommendation,
  ]);
  return fields.every((field) => isContentFreePhrase(normalizeEmissionContent(field)));
}

function isContentFreePhrase(value: string): boolean {
  if (!value) return true;
  return /^(?:pass(?:ed)?|none|n a|not applicable|ok(?:ay)?|all good|no (?:action|changes?|issues?|problems?|concerns?|findings?)(?: needed|required| found| detected| noted)?|(?:issues?|problems?|concerns?|findings?)? ?(?:none|not found|not detected))$/.test(
    value,
  );
}

/** One final-route acceptance per checkpoint plus bounded severity-aware session dedupe. */
export class AdvisorEmissionGuard {
  private readonly capacity: number;
  private readonly seen = new Map<string, AdvisorSeverity>();
  private readonly order: string[] = [];
  private readonly acceptedCheckpoints = new Set<string>();
  private readonly checkpointOrder: string[] = [];

  constructor(records: readonly string[] = [], capacity = MAX_EMISSION_HISTORY) {
    this.capacity = Math.max(1, capacity);
    this.restore(records);
  }

  evaluate(checkpointId: string, review: AdvisorReview): AdvisorEmissionDecision {
    if (review.verdict === "pass") return { accepted: false, reason: "pass" };
    if (isContentFreeAdvisorReview(review)) return { accepted: false, reason: "content-free" };
    if (this.acceptedCheckpoints.has(checkpointId)) {
      return { accepted: false, reason: "checkpoint-budget" };
    }
    const severity = highestAdvisorSeverity(review);
    if (!severity) return { accepted: false, reason: "content-free" };
    const normalized = normalizeReview(review);
    if (!normalized) return { accepted: false, reason: "content-free" };
    const hash = createHash("sha256").update(normalized).digest("hex");
    const previousSeverity = this.seen.get(hash);
    if (previousSeverity && SEVERITY_RANK[previousSeverity] >= SEVERITY_RANK[severity]) {
      return { accepted: false, reason: "duplicate" };
    }

    const rollback: AdvisorEmissionRollback = {
      checkpointId,
      checkpointEvicted: [],
      hash,
      previousSeverity,
      wasNewHash: previousSeverity === undefined,
      hashEvicted: [],
    };
    this.acceptedCheckpoints.add(checkpointId);
    this.checkpointOrder.push(checkpointId);
    while (this.checkpointOrder.length > this.capacity) {
      const stale = this.checkpointOrder.shift();
      if (stale) {
        rollback.checkpointEvicted.push(stale);
        this.acceptedCheckpoints.delete(stale);
      }
    }
    this.record(hash, severity, rollback.hashEvicted);
    return { accepted: true, hash, severity, rollback };
  }

  rollback(token: AdvisorEmissionRollback): void {
    this.acceptedCheckpoints.delete(token.checkpointId);
    const checkpointIndex = this.checkpointOrder.indexOf(token.checkpointId);
    if (checkpointIndex >= 0) this.checkpointOrder.splice(checkpointIndex, 1);
    for (const checkpointId of [...token.checkpointEvicted].reverse()) {
      this.acceptedCheckpoints.add(checkpointId);
      if (!this.checkpointOrder.includes(checkpointId)) this.checkpointOrder.unshift(checkpointId);
    }

    if (token.wasNewHash) {
      this.seen.delete(token.hash);
      const hashIndex = this.order.indexOf(token.hash);
      if (hashIndex >= 0) this.order.splice(hashIndex, 1);
    } else if (token.previousSeverity) {
      this.seen.set(token.hash, token.previousSeverity);
    }
    for (const evicted of [...token.hashEvicted].reverse()) {
      this.seen.set(evicted.hash, evicted.severity);
      if (!this.order.includes(evicted.hash)) this.order.unshift(evicted.hash);
    }
  }

  /** Compact, sanitized records suitable for the checkpoint ledger. */
  exportRecords(): string[] {
    return this.order.flatMap((hash) => {
      const severity = this.seen.get(hash);
      return severity ? [`${severity}:${hash}`] : [];
    });
  }

  reset(records: readonly string[] = []): void {
    this.seen.clear();
    this.order.length = 0;
    this.acceptedCheckpoints.clear();
    this.checkpointOrder.length = 0;
    this.restore(records);
  }

  private restore(records: readonly string[]): void {
    for (const record of records.slice(-this.capacity)) {
      const match = /^(nit|concern|blocker):([a-f\d]{64})$/i.exec(record);
      if (!match) continue;
      this.record(match[2]!.toLowerCase(), match[1]!.toLowerCase() as AdvisorSeverity);
    }
  }

  private record(
    hash: string,
    severity: AdvisorSeverity,
    evicted: Array<{ hash: string; severity: AdvisorSeverity }> = [],
  ): void {
    const previous = this.seen.get(hash);
    if (!previous) this.order.push(hash);
    this.seen.set(hash, severity);
    while (this.order.length > this.capacity) {
      const stale = this.order.shift();
      if (!stale) continue;
      const staleSeverity = this.seen.get(stale);
      if (staleSeverity) evicted.push({ hash: stale, severity: staleSeverity });
      this.seen.delete(stale);
    }
  }
}

function normalizeReview(review: AdvisorReview): string {
  return review.findings
    .map((finding) =>
      normalizeEmissionContent(
        `${finding.category} ${finding.issue} ${finding.evidence} ${finding.recommendation}`,
      ),
    )
    .filter(Boolean)
    .sort()
    .join("\n");
}
