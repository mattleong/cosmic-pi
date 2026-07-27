import { createHash } from "node:crypto";
import { advisorSeverityRank, type AdvisorReview, type AdvisorSeverity } from "./schema.ts";

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
  | { accepted: true; hash: string; severity: AdvisorSeverity; rollback: AdvisorEmissionRollback }
  | { accepted: false; reason: EmissionSuppressionReason };
export interface AdvisorEmissionGuardState {
  readonly capacity: number;
  readonly seen: Readonly<Record<string, AdvisorSeverity>>;
  readonly order: readonly string[];
  readonly acceptedCheckpoints: readonly string[];
  readonly checkpointOrder: readonly string[];
}
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
  for (const finding of review.findings)
    if (!highest || advisorSeverityRank(finding.severity) > advisorSeverityRank(highest))
      highest = finding.severity;
  return highest;
}
export function isContentFreeAdvisorReview(review: AdvisorReview): boolean {
  if (review.verdict === "pass" || review.findings.length === 0) return true;
  return review.findings
    .flatMap((finding) => [finding.issue, finding.evidence, finding.recommendation])
    .every((field) => isContentFreePhrase(normalizeEmissionContent(field)));
}
function isContentFreePhrase(value: string): boolean {
  if (!value) return true;
  return /^(?:pass(?:ed)?|none|n a|not applicable|ok(?:ay)?|all good|no (?:action|changes?|issues?|problems?|concerns?|findings?)(?: needed|required| found| detected| noted)?|(?:issues?|problems?|concerns?|findings?)? ?(?:none|not found|not detected))$/.test(
    value,
  );
}

export const createAdvisorEmissionGuardState = (
  records: readonly string[] = [],
  capacity = MAX_EMISSION_HISTORY,
): AdvisorEmissionGuardState => {
  const state: AdvisorEmissionGuardState = {
    capacity: Math.max(1, capacity),
    seen: {},
    order: [],
    acceptedCheckpoints: [],
    checkpointOrder: [],
  };
  let current = state;
  for (const record of records.slice(-state.capacity)) {
    const match = /^(nit|concern|blocker):([a-f\d]{64})$/i.exec(record);
    if (match)
      current = recordHash(
        current,
        match[2]!.toLowerCase(),
        match[1]!.toLowerCase() as AdvisorSeverity,
      );
  }
  return current;
};

export const evaluateAdvisorEmission = (
  state: AdvisorEmissionGuardState,
  checkpointId: string,
  review: AdvisorReview,
): { readonly state: AdvisorEmissionGuardState; readonly decision: AdvisorEmissionDecision } => {
  if (review.verdict === "pass") return { state, decision: { accepted: false, reason: "pass" } };
  if (isContentFreeAdvisorReview(review))
    return { state, decision: { accepted: false, reason: "content-free" } };
  if (state.acceptedCheckpoints.includes(checkpointId))
    return { state, decision: { accepted: false, reason: "checkpoint-budget" } };
  const severity = highestAdvisorSeverity(review);
  const normalized = normalizeReview(review);
  if (!severity || !normalized)
    return { state, decision: { accepted: false, reason: "content-free" } };
  const hash = createHash("sha256").update(normalized).digest("hex");
  const previousSeverity = state.seen[hash];
  if (previousSeverity && advisorSeverityRank(previousSeverity) >= advisorSeverityRank(severity))
    return { state, decision: { accepted: false, reason: "duplicate" } };
  const rollback: AdvisorEmissionRollback = {
    checkpointId,
    checkpointEvicted: [],
    hash,
    ...(previousSeverity ? { previousSeverity } : {}),
    wasNewHash: previousSeverity === undefined,
    hashEvicted: [],
  };
  const acceptedCheckpoints = [...state.acceptedCheckpoints, checkpointId];
  const checkpointOrder = [...state.checkpointOrder, checkpointId];
  while (checkpointOrder.length > state.capacity) {
    const stale = checkpointOrder.shift();
    if (stale) {
      rollback.checkpointEvicted.push(stale);
      const index = acceptedCheckpoints.indexOf(stale);
      if (index >= 0) acceptedCheckpoints.splice(index, 1);
    }
  }
  const next = recordHash(
    { ...state, acceptedCheckpoints, checkpointOrder },
    hash,
    severity,
    rollback.hashEvicted,
  );
  return { state: next, decision: { accepted: true, hash, severity, rollback } };
};

export const rollbackAdvisorEmission = (
  state: AdvisorEmissionGuardState,
  token: AdvisorEmissionRollback,
): AdvisorEmissionGuardState => {
  const acceptedCheckpoints = state.acceptedCheckpoints.filter((id) => id !== token.checkpointId);
  const checkpointOrder = state.checkpointOrder.filter((id) => id !== token.checkpointId);
  for (const id of [...token.checkpointEvicted].reverse()) {
    if (!acceptedCheckpoints.includes(id)) acceptedCheckpoints.unshift(id);
    if (!checkpointOrder.includes(id)) checkpointOrder.unshift(id);
  }
  const seen: Record<string, AdvisorSeverity> = { ...state.seen };
  const order = [...state.order];
  if (token.wasNewHash) {
    delete seen[token.hash];
    const index = order.indexOf(token.hash);
    if (index >= 0) order.splice(index, 1);
  } else if (token.previousSeverity) seen[token.hash] = token.previousSeverity;
  for (const evicted of [...token.hashEvicted].reverse()) {
    seen[evicted.hash] = evicted.severity;
    if (!order.includes(evicted.hash)) order.unshift(evicted.hash);
  }
  return { ...state, seen, order, acceptedCheckpoints, checkpointOrder };
};

export const exportAdvisorEmissionRecords = (state: AdvisorEmissionGuardState): string[] =>
  state.order.flatMap((hash) => (state.seen[hash] ? [`${state.seen[hash]}:${hash}`] : []));

function recordHash(
  state: AdvisorEmissionGuardState,
  hash: string,
  severity: AdvisorSeverity,
  evicted: Array<{ hash: string; severity: AdvisorSeverity }> = [],
) {
  const seen: Record<string, AdvisorSeverity> = { ...state.seen, [hash]: severity };
  const order = state.seen[hash] ? [...state.order] : [...state.order, hash];
  while (order.length > state.capacity) {
    const stale = order.shift();
    if (!stale) continue;
    const staleSeverity = seen[stale];
    if (staleSeverity) evicted.push({ hash: stale, severity: staleSeverity });
    delete seen[stale];
  }
  return { ...state, seen, order };
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
