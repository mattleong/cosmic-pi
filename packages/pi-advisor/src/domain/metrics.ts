import type { AdvisorInterventionBudgetSnapshot } from "../review/intervention-budget.ts";

/** Provider usage accumulated by the Advisor application domain. */
export interface AdvisorModelUsage {
  provider: string;
  model: string;
  responses: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AdvisorOutcomeMetrics {
  pass: number;
  findings: number;
  perspective: number;
  advice: number;
  guidance: number;
  revision: number;
  recovery: number;
  suppressed: number;
  discarded: number;
  failures: number;
}

export function emptyAdvisorOutcomes(): AdvisorOutcomeMetrics {
  return {
    pass: 0,
    findings: 0,
    perspective: 0,
    advice: 0,
    guidance: 0,
    revision: 0,
    recovery: 0,
    suppressed: 0,
    discarded: 0,
    failures: 0,
  };
}

/** Plain session metrics consumed by projections and command rendering. */
export interface AdvisorSessionMetrics {
  attempted: number;
  pass: number;
  suggest?: number;
  revise: number;
  failure: number;
  discarded: number;
  skippedReviews?: Record<string, number>;
  backgroundState?: "idle" | "queued" | "reviewing" | "revision-pending";
  cacheReadTokens?: number;
  cards?: number;
  cacheWriteTokens?: number;
  activeCatchUpWaits?: number;
  activeToolNames?: readonly string[];
  backlog?: number;
  catchUpCancellations?: number;
  catchUpFailures?: number;
  catchUpTimeouts?: number;
  catchUpWaits?: number;
  childResets?: number;
  cost?: number;
  guidancePaths?: readonly string[];
  hasLastCandidate?: boolean;
  inputTokens?: number;
  lastAction?:
    | "advice"
    | "discarded"
    | "failure"
    | "guidance"
    | "pass"
    | "perspective"
    | "recovery"
    | "revision"
    | "suppressed";
  lastFailureKind?: string;
  latestDurationMs?: number;
  modelResponses?: number;
  outputTokens?: number;
  outcomes: AdvisorOutcomeMetrics;
  blockerVerificationAttempts?: number;
  blockersVerified?: number;
  blockersRejected?: number;
  interventionsDelivered?: number;
  interventionsAcknowledged?: number;
  perspectivesDelivered?: number;
  findingLifecycle?: Record<"open" | "acknowledged" | "resolved" | "superseded", number>;
  interventionBudget?: AdvisorInterventionBudgetSnapshot;
  processedSequence?: number;
  queuedReviews?: number;
  sequence?: number;
  suppressedFindings?: number;
  settledReviews?: number;
  totalDurationMs?: number;
  totalTokens?: number;
  usageByModel?: Record<string, AdvisorModelUsage>;
}
