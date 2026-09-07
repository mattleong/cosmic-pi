import type { AdvisorCheckpoint } from "../runtime/runtime.ts";
import { canonicalAdvisorFindingFingerprint, type AdvisorFinding } from "./schema.ts";

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

/** Deterministically convert model-attested confidence/evidence into routing severity. */
export function gateAdvisorFindings(findings: readonly AdvisorFinding[]): AdvisorFinding[] {
  const accepted: AdvisorFinding[] = [];
  for (const finding of findings) {
    const confidence = finding.confidence ?? "low";
    const evidenceBasis = finding.evidenceBasis ?? "none";
    if (confidence === "low" || evidenceBasis === "none") continue;
    accepted.push(
      finding.severity === "blocker" && (confidence !== "high" || evidenceBasis !== "direct")
        ? { ...finding, severity: "concern" }
        : finding,
    );
  }
  return accepted;
}
