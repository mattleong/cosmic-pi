import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";
import {
  advisorFindingId,
  MAX_FINDING_LIFECYCLE_RECORDS,
  type AdvisorFindingRecord,
} from "../src/review/finding-lifecycle.ts";
import { MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST } from "../src/review/intervention-budget.ts";
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
} from "../src/checkpoint/ledger.ts";

const checkpointLedger = (overrides: Partial<Parameters<typeof createCheckpointLedger>[0]> = {}) =>
  createCheckpointLedger({ fingerprint: "a".repeat(64), anchorId: "anchor", ...overrides });

function entry<DataInput>(id: string, parentId: string | null, data?: DataInput): SessionEntry {
  return data
    ? {
        type: "custom",
        id,
        parentId,
        timestamp: "2024-01-01T00:00:00.000Z",
        customType: ADVISOR_CHECKPOINT_ENTRY_TYPE,
        data,
      }
    : {
        type: "message",
        id,
        parentId,
        timestamp: "2024-01-01T00:00:00.000Z",
        message: { role: "user", content: "hello", timestamp: 1 },
      };
}

function reviewSummary() {
  return summarizeAdvisorReview({
    verdict: "revise",
    summary: "model prose is never retained",
    suggestions: [],
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

function findingRecord(index: number): AdvisorFindingRecord {
  const key = index.toString(16).padStart(64, "0");
  return {
    id: advisorFindingId(key, 0),
    key,
    generation: 0,
    category: "correctness",
    severity: "concern",
    status: "open",
    firstSeenTurn: index,
    lastSeenTurn: index,
  };
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
      thinkingLevel: "medium",
    });
    const ledger = checkpointLedger({
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
      severityCounts: { concern: 1, blocker: 1 },
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
      suggestions: [],
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
    const ledger = checkpointLedger({ reviewSummary: summary });
    const durable = JSON.stringify(ledger);

    expect(durable).not.toMatch(/7fd9c6|b3af10|secret\/file|sk-abcdefghijklmnop|abc\.def\.ghi/);
    expect(durable).toContain('"verdict":"revise"');
    expect(durable).toContain('"blocker":1');
    expect(parseLedger(ledger)).toEqual(ledger);
  });

  test("excludes unsafe unknown configuration from the runtime fingerprint", () => {
    const known = {
      provider: "p",
      model: "m",
      cwd: "/project",
      guidance: "trusted",
      fastMode: true,
      thinkingLevel: "medium",
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
    const ledger = checkpointLedger({ reviewSummary: reviewSummary() });
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

  test("ignores excess root and routing fields but rejects excess review fields", () => {
    const ledger = checkpointLedger();
    expect(
      parseLedger({ ...ledger, future: true, routing: { ...ledger.routing, future: true } }),
    ).toEqual(ledger);
    for (const reviewSummary of [
      { ...ledger.reviewSummary, future: true },
      {
        ...ledger.reviewSummary,
        severityCounts: { ...ledger.reviewSummary.severityCounts, future: 0 },
      },
      {
        ...ledger.reviewSummary,
        categoryCounts: { ...ledger.reviewSummary.categoryCounts, future: 0 },
      },
    ]) {
      expect(parseLedger({ ...ledger, reviewSummary })).toBeUndefined();
    }
  });

  test("defaults the legacy v3 completed-turn field while tolerating unknown root fields", () => {
    const ledger = checkpointLedger({
      cancellationLatched: true,
      immunityUntilCompletedTurn: 4,
    });
    const legacyRouting = {
      cancellationLatched: ledger.routing.cancellationLatched,
      immunityUntilCompletedTurn: ledger.routing.immunityUntilCompletedTurn,
    };

    expect(parseLedger({ ...ledger, routing: legacyRouting, futureRootField: true })).toEqual({
      ...ledger,
      routing: { ...legacyRouting, completedPrimaryTurns: 0 },
    });
  });

  test("keeps valid records from mixed lifecycle input and normalizes their wire fields", () => {
    const ledger = checkpointLedger();
    const valid = findingRecord(1);
    const parsed = parseLedger({
      ...ledger,
      findingLifecycle: [
        { ...valid, futureField: "ignored" },
        { ...findingRecord(2), lastSeenTurn: 1 },
        "not-a-record",
      ],
    });

    expect(parsed?.findingLifecycle).toEqual([valid]);
  });

  test("drops invalid lifecycle numbers and non-JSON extras before writing", () => {
    const valid = findingRecord(1);
    const records = [
      { ...valid, generation: -1, id: advisorFindingId(valid.key, -1) },
      { ...valid, firstSeenTurn: 0.5 },
      { ...valid, lastSeenTurn: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, lastSeenTurn: 0 },
      { ...valid, extra: () => undefined },
      { ...valid, extra: { nested: undefined } },
      { ...valid, extra: { nested: [true, null] } },
    ];
    const ledger = checkpointLedger({ findingLifecycle: records });
    expect(ledger.findingLifecycle).toEqual([valid]);
    expect(parseLedger(ledger)?.findingLifecycle).toEqual([valid]);
  });

  test("normalizes routing values and caps bounded lifecycle state", () => {
    const ledger = checkpointLedger();
    const lifecycle = Array.from({ length: MAX_FINDING_LIFECYCLE_RECORDS + 3 }, (_, index) =>
      findingRecord(index),
    );
    const parsed = parseLedger({
      ...ledger,
      routing: {
        ...ledger.routing,
        interventionBudget: {
          delivered: MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST + 99,
          correctionUsed: "not-a-boolean",
          highestSeverity: "critical",
          futureField: true,
        },
      },
      findingLifecycle: lifecycle,
    });

    expect(parsed?.routing.interventionBudget).toEqual({
      delivered: MAX_AUTOMATIC_INTERVENTIONS_PER_REQUEST,
      correctionUsed: false,
    });
    expect(parsed?.findingLifecycle).toHaveLength(MAX_FINDING_LIFECYCLE_RECORDS);
    expect(parsed?.findingLifecycle?.[0]).toEqual(lifecycle[3]);
    expect(
      checkpointLedger({
        completedPrimaryTurns: -2,
        immunityUntilCompletedTurn: 4.9,
      }).routing,
    ).toEqual({
      cancellationLatched: false,
      completedPrimaryTurns: 0,
      immunityUntilCompletedTurn: 4,
    });
  });

  test("rejects lifecycle records whose ID does not match key and generation", () => {
    const ledger = checkpointLedger();
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
    const ledger = checkpointLedger({ fingerprint, anchorId: "abandoned" });
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
