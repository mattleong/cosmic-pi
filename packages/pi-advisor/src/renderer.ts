import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { safeAdvisorLabel } from "./advisor-label.ts";
import { isRecord } from "./utils.ts";
import {
  formatAdvisorReview,
  MAX_ADVISOR_EVIDENCE_CHARS,
  MAX_ADVISOR_FINDINGS,
  MAX_ADVISOR_ISSUE_CHARS,
  MAX_ADVISOR_RECOMMENDATION_CHARS,
  MAX_ADVISOR_RATIONALE_CHARS,
  MAX_ADVISOR_SUGGESTION_CHARS,
  MAX_ADVISOR_SUGGESTIONS,
  MAX_ADVISOR_SUMMARY_CHARS,
  sanitizeAdvisorReview,
  type AdvisorFinding,
  type AdvisorFindingCategory,
  type AdvisorReview,
  type AdvisorSuggestion,
  type AdvisorSuggestionKind,
} from "./review.ts";

export const ADVISOR_REVIEW_MESSAGE_TYPE = "advisor-review";

const ACTION_LABELS = {
  advice: "Advisor provided advice",
  guidance: "Advisor suggested a course correction",
  perspective: "Advisor offered a possible angle",
  recovery: "Advisor interrupted a stalled trajectory",
  revision: "Advisor requested a revision",
} as const;

export interface AdvisorReviewMessageDetails {
  review: AdvisorReview;
  provider: string;
  model: string;
  action?: keyof typeof ACTION_LABELS;
}

export function registerAdvisorReviewRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<AdvisorReviewMessageDetails>(
    ADVISOR_REVIEW_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details;
      if (
        !details?.review ||
        typeof details.provider !== "string" ||
        typeof details.model !== "string"
      ) {
        return undefined;
      }
      try {
        const normalizedReview = normalizeReviewForDisplay(details.review);
        if (!normalizedReview) return undefined;
        const review = sanitizeAdvisorReview(normalizedReview);
        const label = ACTION_LABELS[details.action ?? "revision"];
        const heading = theme.bold(theme.fg("warning", label));
        const model = theme.fg(
          "muted",
          `${safeAdvisorLabel(details.provider)}/${safeAdvisorLabel(details.model)}`,
        );
        if (expanded) {
          return new Text(`${heading} ${model}\n${formatAdvisorReview(review)}`, 1, 0);
        }

        const perspective = review.suggestions?.length ?? 0;
        const blocker = review.findings.filter((finding) => finding.severity === "blocker").length;
        const concern = review.findings.filter((finding) => finding.severity === "concern").length;
        const nit = review.findings.length - blocker - concern;
        const counts = [
          perspective > 0 ? `${perspective} possible angle` : undefined,
          blocker > 0 ? `${blocker} blocker` : undefined,
          concern > 0 ? `${concern} concern` : undefined,
          nit > 0 ? `${nit} nit` : undefined,
        ]
          .filter((value): value is string => value !== undefined)
          .join(" · ");
        return new Text(
          `${heading} ${model}\n${theme.fg("muted", counts)} · ${review.summary}`,
          1,
          0,
        );
      } catch {
        return undefined;
      }
    },
  );
}

function normalizeReviewForDisplay(value: unknown): AdvisorReview | undefined {
  if (
    !isRecord(value) ||
    (value.verdict !== "pass" && value.verdict !== "suggest" && value.verdict !== "revise") ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.findings)
  ) {
    return undefined;
  }

  const suggestions = normalizeSuggestions(value.suggestions);
  if (!suggestions) return undefined;
  const findings: AdvisorFinding[] = [];
  for (const finding of value.findings.slice(0, MAX_ADVISOR_FINDINGS)) {
    if (
      !isRecord(finding) ||
      (finding.severity !== "nit" &&
        finding.severity !== "concern" &&
        finding.severity !== "blocker" &&
        finding.severity !== "high" &&
        finding.severity !== "medium") ||
      typeof finding.issue !== "string" ||
      !finding.issue.trim() ||
      typeof finding.recommendation !== "string" ||
      !finding.recommendation.trim()
    ) {
      return undefined;
    }
    findings.push({
      category: normalizeCategory(finding.category),
      ...(typeof finding.id === "string" && /^af_[a-f\d]{32}$/u.test(finding.id)
        ? { id: finding.id }
        : {}),
      ...(finding.status === "open" ||
      finding.status === "acknowledged" ||
      finding.status === "resolved" ||
      finding.status === "superseded"
        ? { status: finding.status }
        : {}),
      ...(finding.confidence === "low" ||
      finding.confidence === "medium" ||
      finding.confidence === "high"
        ? { confidence: finding.confidence }
        : {}),
      ...(finding.evidenceBasis === "none" ||
      finding.evidenceBasis === "inferred" ||
      finding.evidenceBasis === "direct"
        ? { evidenceBasis: finding.evidenceBasis }
        : {}),
      severity:
        finding.severity === "high"
          ? "blocker"
          : finding.severity === "medium"
            ? "concern"
            : finding.severity,
      issue: clip(finding.issue.trim(), MAX_ADVISOR_ISSUE_CHARS),
      evidence:
        typeof finding.evidence === "string" && finding.evidence.trim()
          ? clip(finding.evidence.trim(), MAX_ADVISOR_EVIDENCE_CHARS)
          : "Not recorded by this earlier advisor review.",
      recommendation: clip(finding.recommendation.trim(), MAX_ADVISOR_RECOMMENDATION_CHARS),
    });
  }

  return {
    verdict: value.verdict,
    summary: clip(value.summary.trim(), MAX_ADVISOR_SUMMARY_CHARS),
    ...(suggestions.length > 0 ? { suggestions } : {}),
    findings,
  };
}

function normalizeSuggestions(value: unknown): AdvisorSuggestion[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const suggestions: AdvisorSuggestion[] = [];
  for (const suggestion of value.slice(0, MAX_ADVISOR_SUGGESTIONS)) {
    if (
      !isRecord(suggestion) ||
      !isSuggestionKind(suggestion.kind) ||
      (suggestion.relevance !== "possible" &&
        suggestion.relevance !== "likely" &&
        suggestion.relevance !== "high") ||
      typeof suggestion.suggestion !== "string" ||
      !suggestion.suggestion.trim() ||
      typeof suggestion.rationale !== "string" ||
      !suggestion.rationale.trim()
    ) {
      return undefined;
    }
    suggestions.push({
      fingerprint:
        typeof suggestion.fingerprint === "string" && suggestion.fingerprint.trim()
          ? clip(suggestion.fingerprint.trim(), 160)
          : "historical-suggestion",
      kind: suggestion.kind,
      suggestion: clip(suggestion.suggestion.trim(), MAX_ADVISOR_SUGGESTION_CHARS),
      rationale: clip(suggestion.rationale.trim(), MAX_ADVISOR_RATIONALE_CHARS),
      relevance: suggestion.relevance,
    });
  }
  return suggestions;
}

function isSuggestionKind(value: unknown): value is AdvisorSuggestionKind {
  return (
    value === "alternative" ||
    value === "investigation" ||
    value === "verification" ||
    value === "simplification" ||
    value === "tradeoff" ||
    value === "edge-case"
  );
}

function clip(value: string, limit: number): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, Math.max(0, limit - 18))}[... truncated]`;
}

function normalizeCategory(value: unknown): AdvisorFindingCategory {
  return value === "intent" ||
    value === "correctness" ||
    value === "completeness" ||
    value === "evidence"
    ? value
    : "correctness";
}
