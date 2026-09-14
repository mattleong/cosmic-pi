import { describe, expect, it } from "vitest";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../../src/tools/details-schema.ts";
import { view } from "./fixtures/tool-harness.ts";

describe("subagent detail evidence", () => {
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
    const offender = view({
      state: "paused",
      writeIntent: "writer",
      writeClaims: ["src/a.ts"],
      writeAdmissionPaused: true,
      writeViolationOffender: true,
      writeAudit: {
        observedFileWrites: ["src/b.ts"],
        violations: [{ path: "src/b.ts", toolName: "edit", observedAt: 2 }],
        bashWriteHints: 0,
      },
    });
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
