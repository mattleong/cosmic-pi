import type { AdvisorFinding, AdvisorSeverity } from "./review.ts";

export type AdvisorFindingGateReason = "low-confidence" | "no-evidence" | "blocker-gate";

export interface AdvisorFindingGateDecision {
  actionable: boolean;
  effectiveSeverity: AdvisorSeverity;
  finding: AdvisorFinding;
  reason?: AdvisorFindingGateReason;
}

/** Deterministically convert model-attested confidence/evidence into routing severity. */
export function gateAdvisorFinding(finding: AdvisorFinding): AdvisorFindingGateDecision {
  const confidence = finding.confidence ?? "low";
  const evidenceBasis = finding.evidenceBasis ?? "none";
  if (finding.severity === "nit") {
    return {
      actionable: false,
      effectiveSeverity: "nit",
      finding: { ...finding, severity: "nit" },
    };
  }
  if (confidence === "low") {
    return {
      actionable: false,
      effectiveSeverity: "nit",
      finding: { ...finding, severity: "nit" },
      reason: "low-confidence",
    };
  }
  if (evidenceBasis === "none") {
    return {
      actionable: false,
      effectiveSeverity: "nit",
      finding: { ...finding, severity: "nit" },
      reason: "no-evidence",
    };
  }
  if (finding.severity === "blocker" && (confidence !== "high" || evidenceBasis !== "direct")) {
    return {
      actionable: true,
      effectiveSeverity: "concern",
      finding: { ...finding, severity: "concern" },
      reason: "blocker-gate",
    };
  }
  return { actionable: true, effectiveSeverity: finding.severity, finding };
}

export function gateAdvisorFindings(findings: readonly AdvisorFinding[]): {
  actionable: AdvisorFinding[];
  suppressed: number;
} {
  const actionable: AdvisorFinding[] = [];
  let suppressed = 0;
  for (const finding of findings) {
    const decision = gateAdvisorFinding(finding);
    if (!decision.actionable) suppressed += 1;
    else actionable.push(decision.finding);
  }
  return { actionable, suppressed };
}
