import { describe, expect, it } from "vitest";
import * as Predicate from "effect/Predicate";
import type { SubagentRunView } from "../src/run/model.ts";
import { awaitDetails, compactToolDetails } from "../src/tools/details.ts";
import { projectSubagentRunCard } from "../src/tools/details-projection.ts";
import {
  SUBAGENT_CARD_DETAILS_VERSION,
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
        { candidateIndex: 0, candidate: "first", code: "unavailable", reason: "Unavailable." },
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
  host: "local",
  runtime: "pi",
  model: "openai-codex/gpt-5.6-sol",
  effort: "high",
  openaiFastMode: false,
  candidateIndex: 1,
  runId: `agent-r2-${index + 1}`,
});

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
      host: "local",
      runtime: "claude",
      closeOnReport: true,
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

  it("persists bounded optional write claims and audit data in version 2 cards", () => {
    const claimed: SubagentRunView = {
      ...run(),
      writeIntent: "writer",
      writeClaims: ["src/a.ts", "src/b.ts"],
      writeAdmissionPaused: true,
      writeAudit: {
        observedFileWrites: ["src/a.ts", "src/outside.ts"],
        violations: [{ path: "src/outside.ts", toolName: "edit", observedAt: 3 }],
        bashWriteHints: 2,
      },
    };
    const details = compactToolDetails({ action: "claims", runs: [claimed] });
    expect(details).toMatchObject({
      version: 2,
      action: "claims",
      cards: [
        {
          writeClaims: ["src/a.ts", "src/b.ts"],
          writeAdmissionPaused: true,
          writeAudit: {
            observedFileWrites: ["src/a.ts", "src/outside.ts"],
            violations: [{ path: "src/outside.ts", toolName: "edit", observedAt: 3 }],
            bashWriteHints: 2,
          },
        },
      ],
    });
    const decoded = decodeCompactToolDetails(details);
    expect(decoded).toEqual(details);
    expect(Object.isFrozen(decoded)).toBe(true);
  });
});

const auditedRun = (offender: boolean): SubagentRunView => ({
  ...run(),
  writeClaims: Array.from({ length: 20 }, (_, index) => `/repo/claim-${index}.ts`),
  writeAudit: {
    observedFileWrites: Array.from({ length: 20 }, (_, index) => `/repo/written-${index}.ts`),
    violations: Array.from({ length: 20 }, (_, index) => ({
      path: `/repo/violation-${index}.ts`,
      toolName: "write",
      observedAt: index,
    })),
    bashWriteHints: 3,
  },
  writeViolationOffender: offender,
  writeIntent: "writer",
  writeAdmissionPaused: offender,
});

describe("persisted subagent detail fitting", () => {
  it("retains offender evidence and marks omitted claims", () => {
    for (const density of ["full", "compact", "minimal"] as const) {
      const card = projectSubagentRunCard(auditedRun(true), density);
      expect(card.writeClaimCount).toBe(20);
      expect(card.writeViolationOffender).toBe(true);
      expect(card.writeAudit?.violations.length).toBeGreaterThan(0);
      if ((card.writeClaims?.length ?? 0) < 20) expect(card.writeClaimsOmitted).toBe(true);
    }
  });
});
