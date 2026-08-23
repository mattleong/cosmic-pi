import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { AdvisorModelError, type AdvisorModelErrorKind } from "../runtime/client.ts";
import { type AdvisorCheckpoint } from "../runtime/runtime.ts";
import {
  appendAdvisorReviewCardAtHostBoundary,
  sendCompactAdvisorGuidanceAtHostBoundary,
  type AdvisorGuidancePublishResult,
  type AdvisorReviewCardPublishResult,
} from "../boundary/host-review-cards.ts";
import {
  AdvisorReviewParseError,
  canonicalAdvisorFindingFingerprint,
  type AdvisorFinding,
  type AdvisorReview,
} from "../review/index.ts";
import { readAdvisorContextEntriesAtHostBoundary } from "../boundary/host-context.ts";

export interface CancellationLatch {
  readonly await: Effect.Effect<void>;
  readonly cancel: () => void;
}

export const makeCancellationLatch = (): CancellationLatch => {
  let cancelled = false;
  let resume: (() => void) | undefined;
  return {
    await: Effect.callback<void>((complete) => {
      resume = () => complete(Effect.void);
      if (cancelled) resume();
      return Effect.sync(() => {
        resume = undefined;
      });
    }),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      resume?.();
    },
  };
};

export function applyBlockerVerification(
  initial: AdvisorCheckpoint,
  verification: AdvisorCheckpoint,
): AdvisorCheckpoint {
  const verified = verificationFingerprints(verification.findings);
  const findings = initial.findings.filter(
    (finding) =>
      !isVerificationCandidate(finding) ||
      verified.has(canonicalAdvisorFindingFingerprint(finding.fingerprint ?? "")),
  );
  return {
    ...initial,
    verdict: findings.length > 0 ? "revise" : "pass",
    summary: findings.length > 0 ? initial.summary : verification.summary,
    findings,
  };
}

export function isVerificationCandidate(finding: AdvisorFinding): boolean {
  return (
    finding.severity === "blocker" &&
    finding.confidence === "high" &&
    finding.evidenceBasis === "direct"
  );
}

export function verificationFingerprints(findings: readonly AdvisorFinding[]): Set<string> {
  return new Set(
    findings.flatMap((finding) =>
      isVerificationCandidate(finding) && finding.fingerprint
        ? [canonicalAdvisorFindingFingerprint(finding.fingerprint)]
        : [],
    ),
  );
}

export function reviewWithAcknowledgedFindings(
  review: AdvisorReview,
  findingIds: readonly string[],
): AdvisorReview {
  const acknowledged = new Set(findingIds);
  return {
    ...review,
    findings: review.findings.map((finding) =>
      finding.id && acknowledged.has(finding.id) ? { ...finding, status: "acknowledged" } : finding,
    ),
  };
}

export function incrementBounded(value: number | undefined): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (value ?? 0) + 1);
}

export function activeContextMessages(ctx: ExtensionContext): unknown[] {
  const result = readAdvisorContextEntriesAtHostBoundary(ctx);
  return result.ok ? result.value.flatMap(sessionEntryToContextMessages) : [];
}

const MODEL_ERROR_KIND_CLASSIFICATION = {
  authentication: "authentication",
  configuration: "model",
  timeout: "timeout",
  unavailable: "model",
  aborted: "cancelled",
  unknown: "provider",
} satisfies Record<AdvisorModelErrorKind, string>;

export function classifyFailure<ErrorInput>(error: ErrorInput): string {
  if (error instanceof AdvisorReviewParseError) return "response-format";
  if (error instanceof AdvisorModelError && error.kind)
    return MODEL_ERROR_KIND_CLASSIFICATION[error.kind];
  // Message heuristics remain only as a fallback for errors produced outside this extension.
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("auth") || message.includes("credential") || message.includes("api key")) {
    return "authentication";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("unavailable") || message.includes("not configured")) return "model";
  if (message.includes("abort")) return "cancelled";
  return "provider";
}

/** Visible findings are durable local entries and never context messages. */
export function sendAdvisorAdvice(
  pi: ExtensionAPI,
  review: AdvisorReview,
): AdvisorReviewCardPublishResult {
  return appendAdvisorReviewCardAtHostBoundary(pi, review);
}

/** Automatic perspectives are local cards plus compact, non-waking guidance. */
export function sendAdvisorPerspective(
  pi: ExtensionAPI,
  review: AdvisorReview,
): AdvisorGuidancePublishResult {
  const published = appendAdvisorReviewCardAtHostBoundary(pi, review);
  return {
    ...published,
    guidanceSent:
      published.appended && published.card
        ? sendCompactAdvisorGuidanceAtHostBoundary(pi, published.card, false)
        : false,
  };
}

/** Corrections use a local card plus a separate compact hidden guidance message. */
export function sendCorrection(
  pi: ExtensionAPI,
  review: AdvisorReview,
  triggerTurn: boolean,
): AdvisorGuidancePublishResult {
  const published = appendAdvisorReviewCardAtHostBoundary(pi, review);
  return {
    ...published,
    guidanceSent: published.card
      ? sendCompactAdvisorGuidanceAtHostBoundary(pi, published.card, triggerTurn)
      : false,
  };
}
