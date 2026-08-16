import type { AdvisorFinding } from "./schema.ts";

export type AdvisorFindingGateReason = "low-confidence" | "no-evidence" | "blocker-gate";

export interface AdvisorFindingGateDecision {
  actionable: boolean;
  finding: AdvisorFinding;
  reason?: AdvisorFindingGateReason;
}

/** Deterministically convert model-attested confidence/evidence into routing severity. */
export function gateAdvisorFinding(finding: AdvisorFinding): AdvisorFindingGateDecision {
  const confidence = finding.confidence ?? "low";
  const evidenceBasis = finding.evidenceBasis ?? "none";
  if (confidence === "low" || evidenceBasis === "none") {
    return {
      actionable: false,
      finding,
      reason: confidence === "low" ? "low-confidence" : "no-evidence",
    };
  }
  if (finding.severity === "blocker" && (confidence !== "high" || evidenceBasis !== "direct")) {
    return {
      actionable: true,
      finding: { ...finding, severity: "concern" },
      reason: "blocker-gate",
    };
  }
  return { actionable: true, finding };
}

export function gateAdvisorFindings(findings: readonly AdvisorFinding[]) {
  const actionable: AdvisorFinding[] = [];
  let suppressed = 0;
  for (const finding of findings) {
    const decision = gateAdvisorFinding(finding);
    if (!decision.actionable) suppressed += 1;
    else actionable.push(decision.finding);
  }
  return { actionable, suppressed };
}
