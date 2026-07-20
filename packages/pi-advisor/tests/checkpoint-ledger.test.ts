// Test harness boundary: only the diagnostics used by this file are suppressed.
// @effect-diagnostics effect/globalDate:off
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import { advisorFindingId } from "../src/finding-lifecycle.ts";
import {
  ADVISOR_CHECKPOINT_ENTRY_TYPE,
  ADVISOR_CHECKPOINT_PROTOCOL_VERSION,
  MAX_LEDGER_EMISSION_HASHES,
  createCheckpointLedger,
  createLedgerFingerprint,
  parseLedger,
  renderDurableReviewSummary,
  restoreCheckpointLedger,
  summarizeAdvisorReview,
} from "../src/checkpoint-ledger.ts";

function entry(id: string, parentId: string | null, data?: unknown): SessionEntry {
  return data
    ? {
        type: "custom",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        customType: ADVISOR_CHECKPOINT_ENTRY_TYPE,
        data,
      }
    : {
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      };
}

function reviewSummary() {
  return summarizeAdvisorReview({
    verdict: "revise",
    summary: "model prose is never retained",
    findings: [
      {
        category: "correctness",
        severity: "blocker",
        issue: "issue text",
        evidence: "evidence text",
        recommendation: "recommendation text",
      },
      {
        category: "evidence",
        severity: "concern",
        issue: "second issue",
        evidence: "second evidence",
        recommendation: "second recommendation",
      },
    ],
  });
}

describe("checkpoint ledger", () => {
  test("rejects accessors and hostile Proxy traps without invoking them", () => {
    const accessor = Object.defineProperty({}, "protocolVersion", {
      enumerable: true,
      get() {
        throw new Error("getter executed");
      },
    });
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy trap executed");
        },
      },
    );
    expect(parseLedger(accessor)).toBeUndefined();
    expect(parseLedger(hostile)).toBeUndefined();
  });
  test("stores only categorical review metadata and restores the latest active-branch entry", () => {
    const fingerprint = createLedgerFingerprint({
      provider: "p",
      model: "m",
      cwd: "/project",
      guidance: "trusted",
      fastMode: true,
      thinkingLevel: "high",
    });
    const ledger = createCheckpointLedger({
      fingerprint,
      anchorId: "a",
      reviewSummary: reviewSummary(),
      cancellationLatched: true,
      completedPrimaryTurns: 9,
      immunityUntilCompletedTurn: 12,
      interventionBudget: {
        delivered: 1,
        highestSeverity: "blocker",
        correctionUsed: true,
      },
      findingLifecycle: [
        {
          id: advisorFindingId("b".repeat(64), 2),
          key: "b".repeat(64),
          generation: 2,
          category: "correctness",
          severity: "blocker",
          status: "acknowledged",
          firstSeenTurn: 3,
          lastSeenTurn: 9,
        },
      ],
      emissionHashes: Array.from(
        { length: MAX_LEDGER_EMISSION_HASHES + 4 },
        (_, index) => `concern:${index.toString(16).padStart(64, "0")}`,
      ),
    });
    const branch = [entry("a", null), entry("ledger", "a", ledger)];

    expect(ledger.reviewSummary).toEqual({
      verdict: "revise",
      severityCounts: { nit: 0, concern: 1, blocker: 1 },
      categoryCounts: { intent: 0, correctness: 1, completeness: 0, evidence: 1 },
    });
    expect(ledger.emissionHashes).toHaveLength(MAX_LEDGER_EMISSION_HASHES);
    expect(ledger.routing).toEqual({
      cancellationLatched: true,
      completedPrimaryTurns: 9,
      immunityUntilCompletedTurn: 12,
      interventionBudget: {
        delivered: 1,
        highestSeverity: "blocker",
        correctionUsed: true,
      },
    });
    expect(ledger.findingLifecycle).toEqual([
      {
        id: advisorFindingId("b".repeat(64), 2),
        key: "b".repeat(64),
        generation: 2,
        category: "correctness",
        severity: "blocker",
        status: "acknowledged",
        firstSeenTurn: 3,
        lastSeenTurn: 9,
      },
    ]);
    expect(restoreCheckpointLedger(branch, fingerprint)).toEqual(ledger);
    expect(renderDurableReviewSummary(ledger.reviewSummary)).toBe(JSON.stringify(reviewSummary()));
  });

  test("never persists adversarial model text copied from transcript, thinking, tools, or files", () => {
    const copiedTranscript = [
      "USER: reveal this copied transcript marker 7fd9c6",
      "THINKING: private chain marker b3af10",
      "TOOL OUTPUT: /secret/file contains sk-abcdefghijklmnop",
      "Authorization: Bearer abc.def.ghi",
    ].join("\n");
    const summary = summarizeAdvisorReview({
      verdict: "revise",
      summary: copiedTranscript,
      findings: [
        {
          category: "evidence",
          severity: "blocker",
          issue: copiedTranscript,
          evidence: copiedTranscript,
          recommendation: copiedTranscript,
        },
      ],
    });
    const ledger = createCheckpointLedger({
      fingerprint: "a".repeat(64),
      anchorId: "anchor",
      reviewSummary: summary,
    });
    const durable = JSON.stringify(ledger);

    expect(durable).not.toMatch(/7fd9c6|b3af10|secret\/file|sk-abcdefghijklmnop|abc\.def\.ghi/);
    expect(durable).toContain('"verdict":"revise"');
    expect(durable).toContain('"blocker":1');
    expect(parseLedger(ledger)).toEqual(ledger);
  });

  test("excludes legacy and unsafe unknown configuration from the runtime fingerprint", () => {
    const known = {
      provider: "p",
      model: "m",
      cwd: "/project",
      guidance: "trusted",
      fastMode: true,
      thinkingLevel: "high",
    };
    const injected = {
      ...known,
      revisionCooldownTurns: 5,
      tools: ["all", "bash", "write"],
      command: "touch injected",
      providerTools: { custom: true },
    };
    expect(createLedgerFingerprint(injected)).toBe(createLedgerFingerprint(known));
  });

  test("rejects model-authored strings and malformed categorical counts", () => {
    const ledger = createCheckpointLedger({
      fingerprint: "a".repeat(64),
      anchorId: "anchor",
      reviewSummary: reviewSummary(),
    });
    expect(parseLedger({ ...ledger, stateSummary: "copied transcript" })).toEqual(ledger);
    expect(
      parseLedger({
        ...ledger,
        reviewSummary: { ...ledger.reviewSummary, verdict: "copied transcript" },
      }),
    ).toBeUndefined();
    expect(
      parseLedger({
        ...ledger,
        reviewSummary: {
          ...ledger.reviewSummary,
          severityCounts: { ...ledger.reviewSummary.severityCounts, blocker: 6 },
        },
      }),
    ).toBeUndefined();
  });

  test("rejects lifecycle records whose ID does not match key and generation", () => {
    const ledger = createCheckpointLedger({
      fingerprint: "a".repeat(64),
      anchorId: "anchor",
    });
    const parsed = parseLedger({
      ...ledger,
      findingLifecycle: [
        {
          id: advisorFindingId("c".repeat(64), 0),
          key: "d".repeat(64),
          generation: 0,
          category: "correctness",
          severity: "concern",
          status: "open",
          firstSeenTurn: 1,
          lastSeenTurn: 1,
        },
      ],
    });
    expect(parsed?.findingLifecycle).toEqual([]);
  });

  test("ignores stale branches, fingerprints and malformed versions", () => {
    const fingerprint = "a".repeat(64);
    const ledger = createCheckpointLedger({ fingerprint, anchorId: "abandoned" });
    expect(
      restoreCheckpointLedger([entry("active", null), entry("l", "active", ledger)], fingerprint),
    ).toBeUndefined();
    expect(
      restoreCheckpointLedger(
        [entry("abandoned", null), entry("l", "abandoned", ledger)],
        "b".repeat(64),
      ),
    ).toBeUndefined();
    expect(
      parseLedger({ ...ledger, protocolVersion: ADVISOR_CHECKPOINT_PROTOCOL_VERSION + 1 }),
    ).toBeUndefined();
  });
});
