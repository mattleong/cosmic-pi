import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { stringifyJson } from "../boundary/json.ts";
import { isOneOf, isRecord } from "../shared/utils.ts";
import {
  ADVISOR_CONFIDENCES,
  ADVISOR_EVIDENCE_BASES,
  ADVISOR_FINDING_CATEGORIES,
  ADVISOR_SEVERITIES,
  ADVISOR_SUGGESTION_KINDS,
  ADVISOR_SUGGESTION_RELEVANCES,
  ADVISOR_VERDICTS,
  AdvisorReviewParseError,
  AdvisorReviewWireSchema,
  MAX_ADVISOR_EVIDENCE_CHARS,
  MAX_ADVISOR_FINGERPRINT_CHARS,
  MAX_ADVISOR_FINDINGS,
  MAX_ADVISOR_ISSUE_CHARS,
  MAX_ADVISOR_RATIONALE_CHARS,
  MAX_ADVISOR_RECOMMENDATION_CHARS,
  MAX_ADVISOR_REVIEW_CHARS,
  MAX_ADVISOR_SUGGESTION_CHARS,
  MAX_ADVISOR_SUGGESTIONS,
  MAX_ADVISOR_SUMMARY_CHARS,
  reviewError,
  type AdvisorFinding,
  type AdvisorReview,
  type AdvisorSuggestion,
} from "./schema.ts";

export const parseAdvisorReviewEffect = Effect.fn("AdvisorReview.decode")(function* (raw: string) {
  if (raw.length > MAX_ADVISOR_REVIEW_CHARS) {
    return yield* reviewError("Advisor review exceeds the maximum response size.");
  }
  const jsonText = yield* Effect.try({
    try: () => unwrapJson(raw),
    catch: (error) =>
      error instanceof AdvisorReviewParseError
        ? error
        : reviewError("Advisor returned malformed JSON."),
  });
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AdvisorReviewWireSchema))(
    jsonText,
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => reviewError("Advisor review failed schema validation.")));
  return yield* Effect.try({
    try: () => normalizeDecodedAdvisorReview(decoded),
    catch: (error) =>
      error instanceof AdvisorReviewParseError
        ? error
        : reviewError("Advisor review failed schema validation."),
  });
});

/** Pure compatibility parser retained for deterministic parser consumers. */
export function parseAdvisorReview(raw: string): AdvisorReview {
  if (raw.length > MAX_ADVISOR_REVIEW_CHARS) {
    throw reviewError("Advisor review exceeds the maximum response size.");
  }
  const jsonText = unwrapJson(raw);
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(AdvisorReviewWireSchema), {
    onExcessProperty: "error",
  })(jsonText);
  if (Option.isNone(decoded)) {
    // Preserve the established granular diagnostics, but no manually parsed
    // value can cross the boundary when the domain Schema rejects it.
    diagnoseAdvisorReview(raw);
    throw reviewError("Advisor review failed schema validation.");
  }
  return normalizeDecodedAdvisorReview(decoded.value);
}

function normalizeDecodedAdvisorReview(value: unknown) {
  return diagnoseAdvisorReview(stringifyJson(value));
}

function diagnoseAdvisorReview(raw: string): AdvisorReview {
  if (raw.length > MAX_ADVISOR_REVIEW_CHARS) {
    throw reviewError("Advisor review exceeds the maximum response size.");
  }
  const jsonText = unwrapJson(raw);
  const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))(jsonText);
  if (Option.isNone(decoded)) {
    throw reviewError({ message: "Advisor returned malformed JSON." });
  }
  const parsed = decoded.value;

  if (
    !isRecord(parsed) ||
    (!hasExactKeys(parsed, ["verdict", "summary", "suggestions", "findings"]) &&
      !hasExactKeys(parsed, ["verdict", "summary", "findings"]))
  ) {
    throw reviewError(
      "Advisor review must contain exactly verdict, summary, suggestions, and findings.",
    );
  }
  if (!isOneOf(parsed.verdict, ADVISOR_VERDICTS)) {
    throw reviewError('Advisor verdict must be "pass", "suggest", or "revise".');
  }
  const summary = requireBoundedString(parsed.summary, "summary", MAX_ADVISOR_SUMMARY_CHARS);
  const rawSuggestions = parsed.suggestions ?? [];
  if (!Array.isArray(rawSuggestions)) {
    throw reviewError("Advisor suggestions must be an array.");
  }
  if (rawSuggestions.length > MAX_ADVISOR_SUGGESTIONS) {
    throw reviewError(
      `Advisor review must contain at most ${MAX_ADVISOR_SUGGESTIONS} suggestions.`,
    );
  }
  if (!Array.isArray(parsed.findings)) {
    throw reviewError("Advisor findings must be an array.");
  }
  if (parsed.findings.length > MAX_ADVISOR_FINDINGS) {
    throw reviewError(`Advisor review must contain at most ${MAX_ADVISOR_FINDINGS} findings.`);
  }

  const suggestions = rawSuggestions.map((suggestion, index) => parseSuggestion(suggestion, index));
  const parsedFindings = parsed.findings.map((finding, index) => parseFinding(finding, index));
  const fingerprints = new Set<string>();
  for (const [label, values] of [
    ["suggestions", suggestions],
    ["findings", parsedFindings],
  ] as const) {
    for (const value of values) {
      const canonical = canonicalAdvisorFindingFingerprint(value.fingerprint ?? "");
      if (!canonical || fingerprints.has(canonical)) {
        throw reviewError(`Advisor ${label} must use distinct fingerprints.`);
      }
      fingerprints.add(canonical);
    }
  }
  if (parsed.verdict === "pass" && (suggestions.length > 0 || parsedFindings.length > 0)) {
    throw reviewError(
      suggestions.length > 0
        ? "A pass verdict requires empty suggestions and findings arrays."
        : "A pass verdict requires an empty findings array.",
    );
  }
  if (parsed.verdict === "suggest" && (suggestions.length === 0 || parsedFindings.length > 0)) {
    throw reviewError("A suggest verdict requires suggestions and an empty findings array.");
  }
  if (parsed.verdict === "revise" && (parsedFindings.length === 0 || suggestions.length > 0)) {
    throw reviewError("A revise verdict requires findings and an empty suggestions array.");
  }

  const candidate: AdvisorReview = {
    verdict: parsed.verdict,
    summary,
    ...(parsed.suggestions !== undefined || suggestions.length > 0 ? { suggestions } : {}),
    findings: parsedFindings,
  };
  if (Option.isNone(Schema.decodeUnknownOption(AdvisorReviewWireSchema)(candidate))) {
    throw reviewError("Advisor review failed schema validation.");
  }
  return candidate;
}

/** Format the complete structured critique for display. */
function unwrapJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw reviewError("Advisor returned an empty response.");
  if (!trimmed.startsWith("```")) return trimmed;

  const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (!fenced?.[1]?.trim()) {
    throw reviewError("Advisor returned an invalid fenced JSON response.");
  }
  return fenced[1].trim();
}

function parseSuggestion(value: unknown, index: number): AdvisorSuggestion {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["fingerprint", "kind", "suggestion", "rationale", "relevance"])
  ) {
    throw reviewError(
      `Advisor suggestion ${index + 1} must contain exactly fingerprint, kind, suggestion, rationale, and relevance.`,
    );
  }
  if (!isOneOf(value.kind, ADVISOR_SUGGESTION_KINDS)) {
    throw reviewError(`Advisor suggestion ${index + 1} has an invalid kind.`);
  }
  if (!isOneOf(value.relevance, ADVISOR_SUGGESTION_RELEVANCES)) {
    throw reviewError(`Advisor suggestion ${index + 1} has invalid relevance.`);
  }
  return {
    fingerprint: requireBoundedString(
      value.fingerprint,
      `suggestion ${index + 1} fingerprint`,
      MAX_ADVISOR_FINGERPRINT_CHARS,
    ),
    kind: value.kind,
    suggestion: requireBoundedString(
      value.suggestion,
      `suggestion ${index + 1}`,
      MAX_ADVISOR_SUGGESTION_CHARS,
    ),
    rationale: requireBoundedString(
      value.rationale,
      `suggestion ${index + 1} rationale`,
      MAX_ADVISOR_RATIONALE_CHARS,
    ),
    relevance: value.relevance,
  };
}

function parseFinding(value: unknown, index: number): AdvisorFinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "fingerprint",
      "category",
      "severity",
      "confidence",
      "evidenceBasis",
      "issue",
      "evidence",
      "recommendation",
    ])
  ) {
    throw reviewError(
      `Advisor finding ${index + 1} must contain exactly fingerprint, category, severity, confidence, evidenceBasis, issue, evidence, and recommendation.`,
    );
  }
  if (!isOneOf(value.category, ADVISOR_FINDING_CATEGORIES)) {
    throw reviewError(`Advisor finding ${index + 1} has an invalid category.`);
  }
  if (!isOneOf(value.severity, ADVISOR_SEVERITIES)) {
    throw reviewError(`Advisor finding ${index + 1} has an invalid severity.`);
  }
  if (!isOneOf(value.confidence, ADVISOR_CONFIDENCES)) {
    throw reviewError(`Advisor finding ${index + 1} has invalid confidence.`);
  }
  if (!isOneOf(value.evidenceBasis, ADVISOR_EVIDENCE_BASES)) {
    throw reviewError(`Advisor finding ${index + 1} has invalid evidenceBasis.`);
  }
  return {
    fingerprint: requireBoundedString(
      value.fingerprint,
      `finding ${index + 1} fingerprint`,
      MAX_ADVISOR_FINGERPRINT_CHARS,
    ),
    category: value.category,
    severity: value.severity,
    confidence: value.confidence,
    evidenceBasis: value.evidenceBasis,
    issue: requireBoundedString(value.issue, `finding ${index + 1} issue`, MAX_ADVISOR_ISSUE_CHARS),
    evidence: requireBoundedString(
      value.evidence,
      `finding ${index + 1} evidence`,
      MAX_ADVISOR_EVIDENCE_CHARS,
    ),
    recommendation: requireBoundedString(
      value.recommendation,
      `finding ${index + 1} recommendation`,
      MAX_ADVISOR_RECOMMENDATION_CHARS,
    ),
  };
}

function requireBoundedString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw reviewError(`Advisor ${field} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxChars) {
    throw reviewError(`Advisor ${field} exceeds ${maxChars} characters.`);
  }
  return trimmed;
}

export function canonicalAdvisorFindingFingerprint(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length && expectedKeys.every((key, index) => key === keys[index])
  );
}
