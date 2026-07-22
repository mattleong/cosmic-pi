import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { AdvisorModelError } from "../runtime/client.ts";
import {
  type AdvisorCheckpoint,
  type AdvisorRuntimeDriver,
  type AdvisorRuntimeServiceShape,
} from "../runtime/runtime.ts";
import type { ResolvedAdvisorConfig } from "../config/resolve.ts";
import { safeAdvisorLabel } from "../domain/label.ts";
import {
  AdvisorReviewParseError,
  buildAdvisorAdvice,
  buildAdvisorPerspective,
  buildProgressSteer,
  buildRevisionSteer,
  canonicalAdvisorFindingFingerprint,
  sanitizeAdvisorReview,
  type AdvisorFinding,
  type AdvisorReview,
} from "../review/index.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE } from "../ui/renderer.ts";
import { readAdvisorContextEntriesAtHostBoundary } from "../boundary/host-context.ts";
import type { HostNotifierShape } from "./host-notifier.ts";
import type { ReviewPhase } from "./controller-types.ts";

export const advisorRuntimeEffectsFromDriver = (
  driver: AdvisorRuntimeDriver,
): AdvisorRuntimeServiceShape => {
  const modelError = (operation: string) => (error: unknown) =>
    error instanceof AdvisorModelError
      ? error
      : new AdvisorModelError({
          message: error instanceof Error ? error.message : `Advisor ${operation} failed.`,
        });
  const bestEffortCleanup = (operation: string, cleanup: () => Promise<void>) =>
    Effect.tryPromise({ try: () => cleanup(), catch: modelError(operation) }).pipe(
      Effect.catch(() => Effect.void),
    );
  return {
    activeToolNames: () => driver.activeToolNames,
    start: (options) =>
      Effect.tryPromise({ try: () => driver.start(options), catch: modelError("child startup") }),
    checkpoint: (request) =>
      Effect.tryPromise({ try: () => driver.checkpoint(request), catch: modelError("checkpoint") }),
    steer: (observations) =>
      Effect.tryPromise({ try: () => driver.steer(observations), catch: modelError("steering") }),
    reprime: (seed, stateSummary) =>
      Effect.tryPromise({
        try: () => driver.reprime(seed, stateSummary),
        catch: modelError("re-prime"),
      }),
    abort: () => bestEffortCleanup("abort", () => driver.abort()),
    dispose: () => bestEffortCleanup("dispose", () => driver.dispose()),
  };
};

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

export function classifyFailure(error: unknown): string {
  if (error instanceof AdvisorReviewParseError) return "response-format";
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

export function sendTriggeredCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
  recovering = false,
): void {
  sendCorrection(pi, config, review, phase, true, recovering);
}

export function sendAdvisorAdvice(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  sendAdvisorMessage(pi, config, review, "advice", buildAdvisorAdvice);
}

export function sendAdvisorPerspective(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  sendAdvisorMessage(pi, config, review, "perspective", buildAdvisorPerspective);
}

export function sendCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
  triggerTurn: boolean,
  recovering: boolean,
): void {
  const action = recovering ? "recovery" : phase === "progress" ? "guidance" : "revision";
  sendAdvisorMessage(
    pi,
    config,
    review,
    action,
    (safeReview) =>
      phase === "progress"
        ? buildProgressSteer(safeReview, recovering)
        : buildRevisionSteer(safeReview),
    triggerTurn,
  );
}

export function sendAdvisorMessage(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  action: "advice" | "guidance" | "perspective" | "recovery" | "revision",
  content: (review: AdvisorReview) => string,
  triggerTurn = false,
): void {
  if (!config.provider || !config.model) return;
  const safeReview = sanitizeAdvisorReview(review);
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: content(safeReview),
      display: true,
      details: {
        action,
        review: safeReview,
        provider: safeAdvisorLabel(config.provider),
        model: safeAdvisorLabel(config.model),
      },
    },
    triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
  );
}

export function warnIfSetupRequired(
  ctx: ExtensionContext,
  config: ResolvedAdvisorConfig,
  markShown: () => void,
  notify: HostNotifierShape["notify"],
): void {
  if (!config.enabled || config.configured) return;
  markShown();
  notify(
    ctx,
    "Advisor review is enabled but no dedicated model is configured. Use /advisor-settings.",
    "warning",
  );
}

export const _advisorControllerTest = {
  runtimeEffectsFromDriver: advisorRuntimeEffectsFromDriver,
};
