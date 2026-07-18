import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isRecord } from "./utils.ts";
import {
  formatAdvisorReview,
  type AdvisorFinding,
  type AdvisorFindingCategory,
  type AdvisorReview,
} from "./review.ts";

export const ADVISOR_REVIEW_MESSAGE_TYPE = "advisor-review";

export interface AdvisorReviewMessageDetails {
  review: AdvisorReview;
  provider: string;
  model: string;
  action?: "advice" | "guidance" | "recovery" | "revision";
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
        const review = normalizeReviewForDisplay(details.review);
        if (!review) return undefined;
        const label =
          details.action === "advice"
            ? "Advisor noted a concern"
            : details.action === "guidance"
              ? "Advisor suggested a course correction"
              : details.action === "recovery"
                ? "Advisor interrupted a stalled trajectory"
                : "Advisor requested a revision";
        const heading = theme.bold(theme.fg("warning", label));
        const model = theme.fg("muted", `${details.provider}/${details.model}`);
        if (expanded) {
          return new Text(`${heading} ${model}\n${formatAdvisorReview(review)}`, 1, 0);
        }

        const high = review.findings.filter((finding) => finding.severity === "high").length;
        const medium = review.findings.length - high;
        const counts = [
          high > 0 ? `${high} high` : undefined,
          medium > 0 ? `${medium} medium` : undefined,
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
    (value.verdict !== "pass" && value.verdict !== "revise") ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.findings)
  ) {
    return undefined;
  }

  const findings: AdvisorFinding[] = [];
  for (const finding of value.findings) {
    if (
      !isRecord(finding) ||
      (finding.severity !== "high" && finding.severity !== "medium") ||
      typeof finding.issue !== "string" ||
      !finding.issue.trim() ||
      typeof finding.recommendation !== "string" ||
      !finding.recommendation.trim()
    ) {
      return undefined;
    }
    findings.push({
      category: normalizeCategory(finding.category),
      severity: finding.severity,
      issue: finding.issue.trim(),
      evidence:
        typeof finding.evidence === "string" && finding.evidence.trim()
          ? finding.evidence.trim()
          : "Not recorded by this earlier advisor review.",
      recommendation: finding.recommendation.trim(),
    });
  }

  return { verdict: value.verdict, summary: value.summary.trim(), findings };
}

function normalizeCategory(value: unknown): AdvisorFindingCategory {
  return value === "intent" ||
    value === "correctness" ||
    value === "completeness" ||
    value === "evidence"
    ? value
    : "correctness";
}
