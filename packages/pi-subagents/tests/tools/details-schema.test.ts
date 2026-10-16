import { describe, expect, it } from "vitest";
import { compactToolDetails, awaitDetails } from "../../src/tools/details.ts";
import { projectSubagentRunCard } from "../../src/tools/details-projection.ts";
import { STEERING_DELIVERY_STATES } from "../../src/run/model.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../../src/tools/details-decode.ts";
import type { CompactSubagentToolDetails } from "../../src/tools/details-schema.ts";
import { actionFailureDisposition, marksSubagentToolError } from "../../src/tools/outcome.ts";
import { containedWriter } from "../fixtures/run-view.ts";
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

  it("omits invalid pending flags at the producer but classifies decoded ones by action and code", () => {
    const wrongCode = { ...pendingFailure, code: "claude_steering_outcome_uncertain" };
    const definite = { ...pendingFailure, code: "not_running" };
    for (const [action, failure] of [
      ["send", wrongCode],
      ["send", definite],
      ["reply", pendingFailure],
      ["resume", pendingFailure],
    ] as const) {
      const projected = compactToolDetails({ action, runs: [], actionFailures: [failure] });
      expect(actionFailuresOf(projected)?.[0]).not.toHaveProperty("pendingDelivery");
      expect(marksSubagentToolError(projected)).toBe(true);
    }
    const base = compactToolDetails({
      action: "send",
      runs: [],
      actionFailures: [unflaggedFailure],
    });
    for (const [action, failure, disposition] of [
      ["send", pendingFailure, "pending"],
      ["reply", pendingFailure, "unconfirmed"],
      ["stop", pendingFailure, "unconfirmed"],
      ["send", wrongCode, "unconfirmed"],
      ["send", definite, "failed"],
    ] as const) {
      const forged = decodeCompactToolDetails({ ...base, action, actionFailures: [failure] });
      expect(forged).toBeDefined();
      const decoded = actionFailuresOf(forged)?.[0];
      expect(decoded?.pendingDelivery).toBe(true);
      expect(actionFailureDisposition(action, decoded ?? {})).toBe(disposition);
      expect(marksSubagentToolError(forged!)).toBe(disposition !== "pending");
    }
    for (const pendingDelivery of [false, "true", 1, null])
      expect(
        decodeCompactToolDetails({
          ...base,
          actionFailures: [{ ...pendingFailure, pendingDelivery }],
        }),
      ).toBeUndefined();
  });

  it("preserves native delivery evidence at every density without changing historical v2 cards", () => {
    const historical = compactToolDetails({ action: "status", runs: [view()] });
    expect(decodeCompactToolDetails(historical)).toEqual(historical);
    expect(historical).not.toHaveProperty("cards.0.steeringDelivery");
    for (const steeringDelivery of STEERING_DELIVERY_STATES) {
      const run = view({ steeringDelivery, state: "running" });
      for (const density of ["full", "compact", "minimal"] as const) {
        const card = projectSubagentRunCard(run, density);
        expect(card.steeringDelivery).toBe(steeringDelivery);
        expect(card.state).toBe("running");
      }
      const status = compactToolDetails({ action: "status", runs: [run] });
      const awaited = awaitDetails({
        runs: [run],
        awaitedRunIds: [run.id],
        awaitUntil: "all_finished",
      });
      expect(decodeCompactToolDetails(status)).toMatchObject({ cards: [{ steeringDelivery }] });
      expect(decodeStartAwaitCardDetails(awaited)).toMatchObject({ cards: [{ steeringDelivery }] });
    }
    if (historical.action === "models") throw new Error("Expected cards");
    expect(
      decodeCompactToolDetails({
        ...historical,
        cards: historical.cards.map((card) =>
          Object.assign({}, card, { steeringDelivery: "invented" }),
        ),
      }),
    ).toBeUndefined();
  });

  it("does not let report-only provenance hide failures or missing evidence", () => {
    const details = compactToolDetails({
      action: "list",
      runs: [view({ finalText: "report" })],
    });
    if (details.action === "models") throw new Error("Expected run details");
    expect(decodeCompactToolDetails(details)).toEqual(details);
    const { contentOmitted, ...missingOmission } = details;
    expect(contentOmitted).toBe(true);
    expect(decodeCompactToolDetails(missingOmission)).toBeUndefined();
    for (const cards of [
      [],
      details.cards.map((card) => ({ ...card, error: "Failure evidence" })),
      details.cards.map((card) => ({ ...card, errorTruncated: true as const })),
    ]) {
      expect(decodeCompactToolDetails({ ...details, cards })).toBeUndefined();
      expect(
        decodeStartAwaitCardDetails({
          version: 2,
          action: "await",
          cards,
          awaitedRunIds: ["agent-1"],
          awaitUntil: "all_finished",
          contentOmitted: true,
          reportsOnlyOmitted: true,
        }),
      ).toBeUndefined();
    }
    expect(
      decodeCompactToolDetails({
        ...details,
        actionFailures: [{ id: "agent-1", code: "failed", message: "Failure evidence" }],
      }),
    ).toBeUndefined();
  });
  it("round-trips only the current offender bit", () => {
    const offender = containedWriter({ state: "paused" });
    const details = compactToolDetails({ action: "claims", runs: [offender] });

    expect(details).toMatchObject({
      action: "claims",
      cards: [{ writeAdmissionPaused: true, writeViolationOffender: true }],
    });
    expect(decodeCompactToolDetails(details)).toEqual(details);

    if (details.action === "models") throw new Error("Expected run-card details.");
    const forged = {
      ...details,
      cards: details.cards.map((card) =>
        Object.assign({}, card, { writeViolationOffender: false }),
      ),
    };
    expect(decodeCompactToolDetails(forged)).toBeUndefined();

    const peer = compactToolDetails({
      action: "claims",
      runs: [
        view({
          writeIntent: "writer",
          writeClaims: ["src/b.ts"],
          writeAdmissionPaused: true,
        }),
      ],
    });
    expect(peer).not.toHaveProperty("cards.0.writeViolationOffender");
    expect(decodeCompactToolDetails(peer)).toEqual(peer);
    if (peer.action === "models") throw new Error("Expected run-card details.");
    const projectedOffender = {
      ...peer,
      cards: peer.cards.map((card) => Object.assign({}, card, { writeViolationOffender: true })),
    };
    expect(decodeCompactToolDetails(projectedOffender)).toEqual(projectedOffender);
    expect(
      decodeCompactToolDetails({
        ...projectedOffender,
        cards: projectedOffender.cards.map((card) =>
          Object.assign({}, card, { writeIntent: "read-only" }),
        ),
      }),
    ).toBeUndefined();
  });
});
