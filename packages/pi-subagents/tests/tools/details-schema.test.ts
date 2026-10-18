import { captureRegistrations, createToolPresentationHarness } from "pi-code-previews/testing";
import { assert, describe, expect, it } from "vitest";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
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
  it("retains redacted cleanup evidence when fitted without inferring historical cleanup", () => {
    const historical = compactToolDetails({ action: "status", runs: [view()] });
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
          message: `token=cleanup-secret\n${"diagnostic ".repeat(200)}`,
        },
      },
      writerCleanupQuarantined: true,
    });
    const oversized = Array.from({ length: 12 }, (_, index) => ({
      ...run,
      id: `agent-${index}`,
      progress: "p".repeat(512),
      selection: {
        ...run.selection,
        skippedCandidates: Array.from({ length: 8 }, () => ({
          candidate: { runtime: "pi" as const, model: "c".repeat(1_000), effort: "high" as const },
          code: "unavailable",
          reason: "r".repeat(1_000),
        })),
      },
    }));
    for (const runs of [[run], oversized]) {
      const details = compactToolDetails({ action: "status", runs });
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

const statusTool = () =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
      startUiTicker: () => () => undefined,
      toolPresentation: {
        beginStart: () => () => undefined,
        beginAwait: () => () => undefined,
        isLiveHierarchyAvailable: () => false,
      },
    }),
  ).tools.find((tool) => tool.name === "subagent_status")!;

type RunDetails = Exclude<CompactSubagentToolDetails, { readonly action: "models" }>;
/** Run details as session history stored them, under any action string. */
type PersistedDetails = Omit<RunDetails, "action"> & { readonly action: string };

describe("saved run cards", () => {
  const run = view({ name: "historic-run", writeIntent: "writer" });
  const status = compactToolDetails({ action: "status", runs: [run] });
  assert(status.action !== "models");

  /** Replays persisted details through the status renderer, expanded, as history redraws them. */
  const replayed = (details: PersistedDetails) => {
    const harness = createToolPresentationHarness(statusTool(), { width: 160 });
    harness.call({ runIds: [run.id] }, { expanded: true });
    harness.result(
      { content: [{ type: "text", text: "raw history sentinel" }], details },
      { expanded: true },
    );
    return harness.render().join("\n");
  };

  it("falls back to the saved text when details no longer decode", () => {
    const undecodable = { ...status, action: "rename" };
    expect(decodeCompactToolDetails(undecodable)).toBeUndefined();
    expect(replayed(undecodable)).toContain("raw history sentinel");
  });

  it("decodes a list card", () => {
    const listed = compactToolDetails({ action: "list", runs: [run] });
    assert(listed.action !== "models");
    expect(decodeCompactToolDetails(listed)).toEqual(listed);
    expect(replayed(listed)).toContain("historic-run");
  });
});
