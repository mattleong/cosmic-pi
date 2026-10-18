import { describe, expect, it } from "vitest";
import * as Predicate from "effect/Predicate";
import type { SubagentRunView } from "../src/run/model.ts";
import { awaitDetails, compactToolDetails, startDetails } from "../src/tools/details.ts";
import { compactRunIssues } from "../src/tools/compact-run-issues.ts";
import {
  SUBAGENT_CARD_DETAILS_VERSION,
  type SubagentRunCard,
  type SubagentStartEntry,
} from "../src/tools/details-schema.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../src/tools/details-decode.ts";
import { view } from "./fixtures/run-view.ts";

const run = (index = 1, cost?: number): SubagentRunView =>
  view({
    id: `agent-r2-${index}`,
    name: `reader-${index}`,
    task: "Secret full task that must not persist in card details.",
    selection: {
      source: "profile-candidate",
      routeSource: "session",
      candidateIndex: 1,
      reason: "Selected in configured order.",
      skippedCandidates: [
        {
          candidateIndex: 0,
          candidate: { runtime: "pi", model: "first", effort: "high" },
          code: "unavailable",
          reason: "Unavailable.",
        },
      ],
    },
    predecessorRunId: "private-predecessor",
    supersededByRunId: "private-successor",
    remainingCandidateCount: 2,
    retryExhausted: true,
    retryBlocked: true,
    cwd: "/private/project",
    state: "completed",
    runtime: "claude",
    reportGeneration: 1,
    capabilities: ["steer", "interrupt", "parent-contact"],
    model: "provider/model",
    sessionId: "private-session",
    sessionFile: "/private/session.jsonl",
    endedAt: 2,
    lastActivityAt: 2,
    question: { requestId: "private-question", message: "May I continue?" },
    sessionEvents: [{ type: "assistant", text: "private transcript", createdAt: 2 }],
    finalText: `Report ${index}: ${"x".repeat(32_000)}`,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      ...(cost !== undefined && { cost }),
    },
  });

const startedEntry = (
  index = 0,
  name = "review",
): Extract<SubagentStartEntry, { readonly status: "started" }> => ({
  index,
  name,
  profile: "reviewer",
  status: "started",
  routeStatus: "selected",
  runtime: "pi",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  openaiFastMode: false,
  candidateIndex: 1,
  runId: `agent-r2-${index + 1}`,
});

// Long route provenance makes twelve bounded cards exceed the persisted bound before condensing.
const oversizedBatch = (
  base: SubagentRunView,
  overrides: Partial<SubagentRunView> = {},
): ReadonlyArray<SubagentRunView> =>
  Array.from({ length: 12 }, (_, index) => ({
    ...base,
    ...overrides,
    id: `${base.id}-${index}`,
    progress: "p".repeat(600),
    currentTool: "t".repeat(300),
    selection: {
      ...base.selection,
      skippedCandidates: Array.from({ length: 8 }, (_skipped, skip) => ({
        candidateIndex: skip,
        candidate: {
          runtime: "pi",
          model: `candidate-${skip}-${"c".repeat(1_000)}`,
          effort: "high",
        },
        code: "unavailable",
        reason: "r".repeat(1_000),
      })),
    },
  }));

const clone = <Value>(value: Value): Value => structuredClone(value);

const replaceAt = <Item, Next>(
  items: ReadonlyArray<Item>,
  index: number,
  next: (item: Item) => Next,
): Array<Item | Next> => items.map((item, position) => (position === index ? next(item) : item));

type FrozenJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<FrozenJson>
  | { readonly [key: string]: FrozenJson };

const isDeeplyFrozen = (value: FrozenJson | undefined): boolean =>
  Object.isFrozen(value) &&
  (Array.isArray(value)
    ? value.every((child: FrozenJson) => isDeeplyFrozen(child))
    : !Predicate.isObject(value) || Object.values(value).every((child) => isDeeplyFrozen(child)));

const awaitWire = () => clone(awaitDetails({ runs: [run()], awaitUntil: "all_finished" }));

describe("persisted subagent details version 2", () => {
  it("makes and decodes aggregate-bounded, deeply frozen private await cards", () => {
    const details = awaitDetails({
      runs: Array.from({ length: 12 }, (_, index) => run(index + 1)),
      awaitUntil: "all_finished",
    });
    const serialized = JSON.stringify(details);

    expect(details.version).toBe(SUBAGENT_CARD_DETAILS_VERSION);
    expect(details.action).toBe("await");
    expect(details.cards).toHaveLength(12);
    expect(serialized.length).toBeLessThanOrEqual(48_000);
    expect(serialized).not.toContain("Secret full task");
    expect(serialized).not.toContain("/private/project");
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("private-predecessor");
    expect(serialized).not.toContain("private-successor");
    expect(serialized).not.toContain("routeSource");
    expect(serialized).not.toContain('candidateIndex":0');
    expect(details.cards[0]).toMatchObject({
      runtime: "claude",
      reportGeneration: 1,
      context: "fresh",
      writeIntent: "read-only",
      capabilities: ["steer", "interrupt", "parent-contact"],
      startedAt: 1,
      lastActivityAt: 2,
      usage: { totalTokens: 2 },
      question: { message: "May I continue?" },
      selection: { source: "profile-candidate", candidateIndex: 1 },
    });
    expect(isDeeplyFrozen(details)).toBe(true);

    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded).toEqual(details);
    expect(JSON.stringify(decoded).length).toBeLessThanOrEqual(48_000);
    expect(isDeeplyFrozen(decoded)).toBe(true);
  });

  it("persists awaited targets with bounded descendant context but never descendant reports", () => {
    const target = {
      ...run(1),
      parentRunId: "root",
      finalText: "Claimed target report.",
    };
    const child = {
      ...run(2),
      parentRunId: target.id,
      finalText: "Unclaimed descendant report.",
    };
    const extraContext = Array.from({ length: 12 }, (_, index) => ({
      ...run(index + 3),
      parentRunId: target.id,
      finalText: `Unclaimed context ${index}.`,
    }));
    const details = awaitDetails({
      runs: [target],
      contextRuns: [child, ...extraContext],
      awaitedRunIds: [target.id],
      awaitUntil: "all_finished",
    });

    expect(details.awaitedRunIds).toEqual([target.id]);
    expect(details.cards).toHaveLength(12);
    expect(details.cards[0]).toMatchObject({ id: target.id, finalText: "Claimed target report." });
    expect(details.cards[1]).toMatchObject({ id: child.id, finalTextTruncated: true });
    expect(details.cards[1]?.finalText).toBeUndefined();
    expect(details.contextOmitted).toBe(true);
    expect(JSON.stringify(details)).not.toContain("Unclaimed descendant report");

    const forged = {
      ...details,
      cards: replaceAt(details.cards, 1, (card) => ({
        ...card,
        finalText: "Forged descendant report.",
      })),
    };
    expect(decodeStartAwaitCardDetails(forged)).toBeUndefined();
  });
  it("returns undefined for known throwing getters and proxies", () => {
    const throwing = awaitWire();
    Object.defineProperty(throwing, "cards", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(decodeStartAwaitCardDetails(throwing)).toBeUndefined();

    const proxied = new Proxy(awaitWire(), {
      get() {
        throw new Error("hostile proxy");
      },
    });
    expect(decodeStartAwaitCardDetails(proxied)).toBeUndefined();
  });

  it("rejects old versions, unsupported versions, wrong discriminants, and wrong shapes", () => {
    const awaitWireDetails = awaitWire();
    expect(decodeStartAwaitCardDetails({ ...awaitWireDetails, version: 1 })).toBeUndefined();
    expect(decodeStartAwaitCardDetails({ ...awaitWireDetails, version: 3 })).toBeUndefined();
    expect(
      decodeStartAwaitCardDetails({ ...awaitWireDetails, awaitedRunIds: ["missing-run"] }),
    ).toBeUndefined();
    expect(decodeStartAwaitCardDetails({ ...awaitWireDetails, action: "start" })).toBeUndefined();
    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "await",
        cards: [],
      }),
    ).toBeUndefined();
    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "await",
        cards: [],
        awaitUntil: "all_finished",
        startEntries: [startedEntry()],
      }),
    ).toBeUndefined();
    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "start",
        startEntries: [startedEntry()],
        cards: [],
      }),
    ).toBeUndefined();
    expect(decodeStartAwaitCardDetails(null)).toBeUndefined();
    expect(decodeStartAwaitCardDetails([])).toBeUndefined();
  });

  it("persists a worktree writer's workspace outcome", () => {
    const outcomes = [
      { status: "auto-discarded" },
      { status: "proposal", changedFileCount: 3, uncapturedFileCount: 1 },
    ] as const;
    for (const workspaceOutcome of outcomes) {
      const writer: SubagentRunView = {
        ...run(),
        writeIntent: "writer",
        writerWorkspaceMode: "worktree",
        workspaceId: "ws-1",
        workspaceOutcome,
      };
      for (const runs of [[writer], oversizedBatch(writer)]) {
        const details = compactToolDetails({ action: "stop", runs });
        const decoded = decodeCompactToolDetails(details);
        expect(
          decoded?.action === "models" ? undefined : decoded?.cards[0]?.workspaceOutcome,
        ).toEqual(workspaceOutcome);
      }
    }
  });
});

describe("proposal diffstat evidence", () => {
  it("persists a proposal's bounded diffstat, keeping its totals when condensed", () => {
    const workspaceOutcome = {
      status: "proposal",
      changedFileCount: 2,
      diffStat: {
        addedLines: 5,
        deletedLines: 1,
        files: [
          { path: "src/a.ts", addedLines: 5, deletedLines: 1 },
          { path: "logo.png", addedLines: 0, deletedLines: 0, binary: true },
        ],
      },
    } as const;
    const writer: SubagentRunView = {
      ...run(),
      writeIntent: "writer",
      writerWorkspaceMode: "worktree",
      workspaceId: "ws-1",
      workspaceOutcome,
    };
    const outcomes = [[writer], oversizedBatch(writer)].map((runs) => {
      const decoded = decodeCompactToolDetails(compactToolDetails({ action: "stop", runs }));
      return decoded?.action === "models" ? undefined : decoded?.cards[0]?.workspaceOutcome;
    });
    expect(outcomes).toEqual([
      workspaceOutcome,
      { ...workspaceOutcome, diffStat: { addedLines: 5, deletedLines: 1, files: [] } },
    ]);
  });
});

const writerRun = (): SubagentRunView => ({ ...run(), writeIntent: "writer" });

const runCards = (details: ReturnType<typeof compactToolDetails>) =>
  details.action === "models" ? [] : details.cards;

const startRunIds = (items: ReadonlyArray<SubagentStartEntry>) =>
  items.map((entry) => (entry.status === "started" ? entry.runId : undefined));

const issueMessages = (cards: ReadonlyArray<SubagentRunCard>) =>
  new Map(
    compactRunIssues(cards)
      .filter((issue) => !issue.code.endsWith(":selection-skipped"))
      .map((issue) => [issue.code, issue.message]),
  );

describe("persisted subagent detail fitting", () => {
  it("fits oversized batches within the bound and keeps IDs and recovery evidence", () => {
    const runs = oversizedBatch(writerRun(), {
      cleanup: {
        disposition: "quarantined",
        recovery: "stop",
        diagnostic: { phase: "process-group", code: "cleanup_unconfirmed", message: "Unconfirmed" },
      },
      writerWorkspaceMode: "worktree",
      workspaceId: "ws-oversized",
    });
    for (const action of ["stop", "interrupt"] as const) {
      const details = compactToolDetails({
        action,
        runs,
        actionFailures: [{ id: "agent-missing", code: "not_found", message: "Run not found." }],
      });
      expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
      expect(decodeCompactToolDetails(details)).toEqual(details);
      expect(details).toMatchObject({
        contentOmitted: true,
        runCount: runs.length,
        actionFailures: [{ id: "agent-missing", code: "not_found", message: "Run not found." }],
      });
      const cards = runCards(details);
      expect(cards.map((card) => card.id).toSorted()).toEqual(
        runs.map((item) => item.id).toSorted(),
      );
      for (const card of cards) {
        expect(card).toMatchObject({
          workspaceId: "ws-oversized",
          cleanup: {
            disposition: "quarantined",
            recovery: "stop",
            diagnostic: { phase: "process-group", code: "cleanup_unconfirmed" },
          },
        });
        expect(card.finalText).toBeUndefined();
      }
    }
  });

  it("fits oversized start batches with run IDs and launch recovery intact", () => {
    const entries = Array.from({ length: 32 }, (_, index): SubagentStartEntry => {
      const { runId, ...selected } = startedEntry(index, `launch-${index}`);
      const fields = {
        ...selected,
        warning: `Route warning ${index}: ${"w".repeat(1_000)}`,
        sourceCwd: `/source/${"s".repeat(200)}`,
      };
      return index % 2 === 0 ? { ...fields, runId } : { ...fields, status: "failed" };
    });
    const failures = entries
      .filter((entry) => entry.status === "failed")
      .map((entry) => ({
        index: entry.index,
        message: `Launch ${entry.index} failed: ${"m".repeat(500)}`,
        code: "launch_failed",
        admittedRun: {
          runId: `agent-admitted-${entry.index}`,
          cleanupDisposition: "confirmed" as const,
          retryDisposition: "eligible" as const,
          remainingCandidateCount: 1,
          hasRemainingCandidate: true,
        },
      }));
    const details = startDetails({ startEntries: entries, startFailures: failures });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(decodeStartAwaitCardDetails(details)).toEqual(details);
    expect(startRunIds(details.startEntries)).toEqual(startRunIds(entries));
    expect(details.startFailures?.map((failure) => failure.admittedRun)).toEqual(
      failures.map((failure) => failure.admittedRun),
    );
    for (const entry of details.startEntries)
      expect(entry.routeStatus === "selected" && entry.warning).toMatch(/^Route warning \d+: w/u);
  });

  it("keeps collapsed issue messages when cards are condensed", () => {
    const runs = oversizedBatch(
      view({
        id: "agent-heavy",
        state: "waiting_for_parent",
        question: { requestId: "question", message: `Proceed? ${"q".repeat(2_000)}` },
        warning: `Child warning: ${"w".repeat(500)}`,
        warningSource: "child",
      }),
    );
    const bounded = runs.flatMap((item) =>
      runCards(compactToolDetails({ action: "stop", runs: [item] })),
    );
    const details = compactToolDetails({ action: "stop", runs });
    expect(details.contentOmitted).toBe(true);
    const condensed = issueMessages(runCards(details));
    expect(condensed).toEqual(issueMessages(bounded));
    expect(condensed.size).toBeGreaterThanOrEqual(runs.length);
  });
});
