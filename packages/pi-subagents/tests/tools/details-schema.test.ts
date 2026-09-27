import { describe, expect, it } from "vitest";
import {
  makeCompactToolDetails,
  makeAwaitDetails,
  projectSubagentRunCard,
} from "../../src/tools/details.ts";
import { STEERING_DELIVERY_STATES } from "../../src/run/model.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../../src/tools/details-schema.ts";
import { actionFailureDisposition, marksSubagentToolError } from "../../src/tools/outcome.ts";
import { containedWriter } from "../fixtures/run-view.ts";
import { view } from "./fixtures/tool-harness.ts";

const pendingFailure = {
  id: "pending",
  code: "steer_outcome_uncertain",
  message: "Guidance may have been sent; acknowledgement is pending. Do not resend.",
  pendingDelivery: true as const,
};
/** Historical and generic uncertain failures carry the same code without the typed flag. */
const unflaggedFailure = {
  id: pendingFailure.id,
  code: pendingFailure.code,
  message: pendingFailure.message,
};

const actionFailuresOf = <ValueInput>(value: ValueInput) => {
  const decoded = decodeCompactToolDetails(value);
  if (!decoded || decoded.action === "models") return undefined;
  return decoded.actionFailures;
};

describe("subagent detail evidence", () => {
  it("keeps typed pending delivery additive, send-scoped, and distinct from uncertainty", () => {
    const pending = makeCompactToolDetails({
      action: "send",
      runs: [view()],
      actionFailures: [pendingFailure],
    });
    expect(decodeCompactToolDetails(pending)).toEqual(pending);
    expect(actionFailuresOf(pending)).toEqual([expect.objectContaining({ pendingDelivery: true })]);
    // Pending-only and pending-plus-confirmed results are not Pi tool errors.
    expect(marksSubagentToolError(pending)).toBe(false);
    const unflagged = makeCompactToolDetails({
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
      const mixed = makeCompactToolDetails({ action, runs: [], actionFailures: failures });
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
      const projected = makeCompactToolDetails({ action, runs: [], actionFailures: [failure] });
      expect(actionFailuresOf(projected)?.[0]).not.toHaveProperty("pendingDelivery");
      expect(marksSubagentToolError(projected)).toBe(true);
    }
    const base = makeCompactToolDetails({
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
      // Structurally valid flags decode, so receipts keep their error semantics.
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
    const historical = makeCompactToolDetails({ action: "status", runs: [view()] });
    expect(decodeCompactToolDetails(historical)).toEqual(historical);
    expect(historical).not.toHaveProperty("cards.0.steeringDelivery");
    for (const steeringDelivery of STEERING_DELIVERY_STATES) {
      const run = view({ steeringDelivery, state: "running" });
      for (const density of ["full", "compact", "minimal"] as const) {
        const card = projectSubagentRunCard(run, density);
        expect(card.steeringDelivery).toBe(steeringDelivery);
        expect(card.state).toBe("running");
      }
      const status = makeCompactToolDetails({ action: "status", runs: [run] });
      const awaited = makeAwaitDetails({
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
        cards: historical.cards.map((card) => ({ ...card, steeringDelivery: "invented" })),
      }),
    ).toBeUndefined();
  });

  it("does not let report-only provenance hide failures or missing evidence", () => {
    const details = makeCompactToolDetails({
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
    const details = makeCompactToolDetails({ action: "claims", runs: [offender] });

    expect(details).toMatchObject({
      action: "claims",
      cards: [{ writeAdmissionPaused: true, writeViolationOffender: true }],
    });
    expect(decodeCompactToolDetails(details)).toEqual(details);

    if (details.action === "models") throw new Error("Expected run-card details.");
    const forged = {
      ...details,
      cards: details.cards.map((card) => ({ ...card, writeViolationOffender: false })),
    };
    expect(decodeCompactToolDetails(forged)).toBeUndefined();

    const peer = makeCompactToolDetails({
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
      cards: peer.cards.map((card) => ({ ...card, writeViolationOffender: true })),
    };
    expect(decodeCompactToolDetails(projectedOffender)).toEqual(projectedOffender);
    expect(
      decodeCompactToolDetails({
        ...projectedOffender,
        cards: projectedOffender.cards.map((card) => ({ ...card, writeIntent: "read-only" })),
      }),
    ).toBeUndefined();
  });
});
