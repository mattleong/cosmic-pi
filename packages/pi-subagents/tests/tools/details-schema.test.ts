import { describe, expect, it } from "vitest";
import { compactToolDetails } from "../../src/tools/details.ts";
import { decodeCompactToolDetails } from "../../src/tools/details-decode.ts";
import { actionFailureDisposition, hasSubagentToolFailure } from "../../src/tools/outcome.ts";
import { view } from "./fixtures/tool-harness.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

describe("subagent detail evidence", () => {
  it("retains redacted cleanup evidence when fitted without inferring historical cleanup", () => {
    const historical = compactToolDetails({ action: "stop", runs: [view()] });
    expect(decodeCompactToolDetails(historical)).toEqual(historical);
    expect(historical).not.toHaveProperty("cards.0.cleanup");
    expect(historical).not.toHaveProperty("cards.0.writerCleanupQuarantined");
    const run = view({
      state: "completed",
      finalText: "Accepted work report",
      writeIntent: "writer",
      cleanup: {
        disposition: "quarantined",
        recovery: "stop",
        diagnostic: {
          phase: "process-group",
          code: "cleanup_unconfirmed",
          message: `token=cleanup-secret\n${Fn.pipe("diagnostic ", Str.repeat(200))}`,
        },
      },
      writerCleanupQuarantined: true,
    });
    const oversized = Array.from({ length: 12 }, (_, index) => ({
      ...run,
      id: `agent-${index}`,
      progress: Fn.pipe("p", Str.repeat(512)),
      selection: {
        ...run.selection,
        skippedCandidates: Array.from({ length: 8 }, () => ({
          candidate: {
            model: Fn.pipe("c", Str.repeat(1_000)),
            effort: "high" as const,
          },
          code: "unavailable",
          reason: Fn.pipe("r", Str.repeat(1_000)),
        })),
      },
    }));
    for (const runs of [[run], oversized]) {
      const details = compactToolDetails({ action: "stop", runs });
      expect(decodeCompactToolDetails(details)).toEqual(details);
      expect(details.action === "models" ? 0 : details.cards.length).toBe(runs.length);
      for (const card of details.action === "models" ? [] : details.cards) {
        expect(card).toMatchObject({
          state: "completed",
          cleanup: { disposition: "quarantined", recovery: "stop" },
          writerCleanupQuarantined: true,
        });
        expect(card.cleanup?.diagnostic?.message.length).toBeLessThanOrEqual(1_024);
        expect(JSON.stringify(card.cleanup)).not.toContain("cleanup-secret");
      }
    }
    const details = compactToolDetails({ action: "stop", runs: [run] });
    expect(Object.isFrozen(decodeCompactToolDetails(details))).toBe(true);
  });

  it("marks unconfirmed and failed targets as tool failures", () => {
    for (const failure of [
      { id: "unconfirmed", code: "guidance_outcome_uncertain", message: "May have applied." },
      { id: "definite", code: "not_running", message: "Not running" },
    ]) {
      const details = compactToolDetails({ action: "stop", runs: [], actionFailures: [failure] });
      expect(decodeCompactToolDetails(details)).toEqual(details);
      expect(hasSubagentToolFailure(details)).toBe(true);
    }
    expect(actionFailureDisposition({ code: "guidance_outcome_uncertain" })).toBe("unconfirmed");
    expect(actionFailureDisposition({ code: "not_running" })).toBe("failed");
  });
});
