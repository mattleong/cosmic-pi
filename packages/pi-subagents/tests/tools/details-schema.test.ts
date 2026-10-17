import { describe, expect, it } from "vitest";
import { compactToolDetails } from "../../src/tools/details.ts";
import { projectSubagentRunCard } from "../../src/tools/details-projection.ts";
import { decodeCompactToolDetails } from "../../src/tools/details-decode.ts";
import type { CompactSubagentToolDetails } from "../../src/tools/details-schema.ts";
import { actionFailureDisposition, marksSubagentToolError } from "../../src/tools/outcome.ts";
import { view } from "./fixtures/tool-harness.ts";

const pendingFailure = {
  id: "pending",
  code: "steer_outcome_uncertain",
  message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
  pendingDelivery: true as const,
};
const unflaggedFailure = {
  id: pendingFailure.id,
  code: pendingFailure.code,
  message: pendingFailure.message,
};

const actionFailuresOf = (value: CompactSubagentToolDetails | undefined) => {
  const decoded = decodeCompactToolDetails(value);
  if (!decoded || decoded.action === "models") return undefined;
  return decoded.actionFailures;
};

describe("subagent detail evidence", () => {
  it("retains redacted cleanup evidence at every density without inferring historical cleanup", () => {
    const historical = compactToolDetails({ action: "status", runs: [view()] });
    expect(decodeCompactToolDetails(historical)).toEqual(historical);
    expect(historical).not.toHaveProperty("cards.0.cleanup");
    expect(historical).not.toHaveProperty("cards.0.writerCleanupQuarantined");
    const run = view({
      state: "completed",
      finalText: "Accepted work report",
      writeIntent: "writer",
      writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
      cleanup: {
        disposition: "quarantined",
        recovery: "stop",
        diagnostic: {
          phase: "process-group",
          code: "cleanup_unconfirmed",
          message: `token=cleanup-secret\n${"diagnostic ".repeat(200)}`,
        },
      },
      writerCleanupQuarantined: true,
    });
    for (const density of ["full", "compact", "minimal"] as const) {
      const card = projectSubagentRunCard(run, density);
      expect(card).toMatchObject({
        state: "completed",
        cleanup: { disposition: "quarantined", recovery: "stop" },
        writerCleanupQuarantined: true,
      });
      expect(card.cleanup?.diagnostic?.message.length).toBeLessThanOrEqual(1_024);
      expect(JSON.stringify(card.cleanup)).not.toContain("cleanup-secret");
      expect(card).not.toHaveProperty("writeViolationOffender");
      expect(card).not.toHaveProperty("writeAdmissionPaused");
      const details = { version: 2, action: "status", runCount: 1, cards: [card] };
      expect(decodeCompactToolDetails(details)).toEqual(details);
    }
    const details = compactToolDetails({ action: "status", runs: [run] });
    expect(decodeCompactToolDetails(details)).toEqual(details);
    expect(Object.isFrozen(decodeCompactToolDetails(details))).toBe(true);
  });

  it("keeps typed pending delivery additive, send-scoped, and distinct from uncertainty", () => {
    const pending = compactToolDetails({
      action: "send",
      runs: [view()],
      actionFailures: [pendingFailure],
    });
    expect(decodeCompactToolDetails(pending)).toEqual(pending);
    expect(actionFailuresOf(pending)).toEqual([expect.objectContaining({ pendingDelivery: true })]);
    expect(marksSubagentToolError(pending)).toBe(false);
    const unflagged = compactToolDetails({
      action: "send",
      runs: [],
      actionFailures: [unflaggedFailure],
    });
    expect(decodeCompactToolDetails(unflagged)).toEqual(unflagged);
    expect(actionFailureDisposition("send", unflaggedFailure)).toBe("unconfirmed");
    expect(marksSubagentToolError(unflagged)).toBe(true);
    for (const [action, failures] of [
      ["send", [pendingFailure, { id: "definite", code: "not_running", message: "Not running" }]],
      ["send", [pendingFailure, { ...unflaggedFailure, id: "unflagged" }]],
    ] as const) {
      const mixed = compactToolDetails({ action, runs: [], actionFailures: failures });
      expect(marksSubagentToolError(mixed)).toBe(true);
    }
  });
});
