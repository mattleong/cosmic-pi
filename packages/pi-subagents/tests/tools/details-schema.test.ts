import { describe, expect, it } from "vitest";
import { makeCompactToolDetails } from "../../src/tools/details.ts";
import { decodeCompactToolDetails } from "../../src/tools/details-schema.ts";
import { view } from "./fixtures/tool-harness.ts";

describe("subagent writer containment card details", () => {
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
    expect(
      decodeCompactToolDetails({
        ...peer,
        cards: peer.cards.map((card) => ({ ...card, writeViolationOffender: true })),
      }),
    ).toBeUndefined();
  });
});
