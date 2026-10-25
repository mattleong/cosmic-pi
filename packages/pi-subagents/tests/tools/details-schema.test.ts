import { captureRegistrations, createToolPresentationHarness } from "pi-code-previews/testing";
import { assert, describe, expect, it } from "vitest";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { compactToolDetails } from "../../src/tools/details.ts";
import { decodeCompactToolDetails } from "../../src/tools/details-decode.ts";
import type { CompactSubagentToolDetails } from "../../src/tools/details-schema.ts";
import { actionFailureDisposition, hasSubagentToolFailure } from "../../src/tools/outcome.ts";
import { view } from "./fixtures/tool-harness.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

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
    expect(decodeCompactToolDetails(details)).toEqual(details);
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

const lifecycleTool = () =>
  Option.getOrUndefined(
    Arr.findFirst(
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
      ).tools,
      (tool) => tool.name === "agent_lifecycle",
    ),
  )!;

type RunDetails = Exclude<CompactSubagentToolDetails, { readonly action: "models" }>;
/** Run details as session history stored them, under any action string. */
type PersistedDetails = Omit<RunDetails, "action"> & { readonly action: string };

describe("saved run cards", () => {
  const run = view({ name: "historic-run", writeIntent: "writer" });
  const stopped = compactToolDetails({ action: "stop", runs: [run] });
  assert(stopped.action !== "models");

  /** Replays persisted details through the lifecycle renderer, expanded, as history redraws them. */
  const replayed = (details: PersistedDetails) => {
    const harness = createToolPresentationHarness(lifecycleTool(), { width: 160 });
    harness.call({ action: "stop", runIds: [run.id] }, { expanded: true });
    harness.result(
      { content: [{ type: "text", text: "raw history sentinel" }], details },
      { expanded: true },
    );
    return Arr.join(harness.render(), "\n");
  };

  it("falls back to the saved text when details no longer decode", () => {
    const undecodable = { ...stopped, action: "rename" };
    expect(decodeCompactToolDetails(undecodable)).toBeUndefined();
    expect(replayed(undecodable)).toContain("raw history sentinel");
  });

  it("decodes a stop card", () => {
    expect(decodeCompactToolDetails(stopped)).toEqual(stopped);
    expect(replayed(stopped)).toContain("historic-run");
  });
});
