import { describe, expect, it } from "vitest";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../src/tools/details-decode.ts";
import { makeCompactToolDetails, makeStartAwaitCardDetails } from "../src/tools/details.ts";

const run = (index = 1): SubagentRunView => ({
  id: `agent-r1-${index}`,
  name: `reader-${index}`,
  task: "Secret full task that must not persist in card details.",
  selection: {
    source: "profile-candidate",
    routeSource: "session",
    host: "herdr",
    runtime: "claude",
    closeOnReport: false,
    candidateIndex: 0,
    reason: "Selected in configured order.",
    skippedCandidates: [{ candidate: "first", code: "unavailable", reason: "Unavailable." }],
  },
  cwd: "/private/project",
  state: "reported",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  host: "herdr",
  runtime: "claude",
  closeOnReport: false,
  reportGeneration: 1,
  capabilities: ["resume"],
  model: "provider/model",
  effort: "high",
  sessionId: "private-session",
  sessionFile: "/private/session.jsonl",
  startedAt: 1,
  endedAt: 2,
  lastActivityAt: 2,
  sessionEvents: [{ type: "assistant", text: "private transcript", createdAt: 2 }],
  finalText: `Report ${index}: ${"x".repeat(32_000)}`,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 },
});

describe("persisted subagent card details", () => {
  it("stores only rendered fields in a versioned, deeply frozen aggregate-bound projection", () => {
    const details = makeStartAwaitCardDetails({
      action: "await",
      runs: Array.from({ length: 12 }, (_, index) => run(index + 1)),
      awaitUntil: "all_finished",
    });
    const serialized = JSON.stringify(details);

    expect(details.version).toBe(1);
    expect(details.cards).toHaveLength(12);
    expect(details.cards[0]).toMatchObject({
      host: "herdr",
      runtime: "claude",
      closeOnReport: false,
      reportGeneration: 1,
      context: "fresh",
      writeIntent: "read-only",
      capabilities: ["resume"],
      startedAt: 1,
      lastActivityAt: 2,
      usage: { totalTokens: 2 },
      finalTextTruncated: true,
      selection: {
        routeSource: "session",
        host: "herdr",
        runtime: "claude",
        closeOnReport: false,
      },
    });
    expect(serialized.length).toBeLessThanOrEqual(48_000);
    expect(serialized).not.toContain("Secret full task");
    expect(serialized).not.toContain("/private/project");
    expect(serialized).not.toContain("private-session");
    expect(serialized).not.toContain("private transcript");
    expect(Object.isFrozen(details)).toBe(true);
    expect(Object.isFrozen(details.cards)).toBe(true);
    expect(Object.isFrozen(details.cards[0]?.selection.skippedCandidates)).toBe(true);
  });

  it("bounds serialized escaping expansion and unsupported explicit versions", () => {
    const hostile = `${"\\".repeat(20_000)}${"\ud800".repeat(4_000)}`;
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: Array.from({ length: 12 }, (_, index) => ({
        ...run(index + 1),
        id: `${index}-${hostile}`,
        name: hostile,
        model: hostile,
        finalText: hostile,
        selection: {
          source: "profile-candidate" as const,
          reason: hostile,
          skippedCandidates: [{ candidate: hostile, code: hostile, reason: hostile }],
        },
      })),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(details.contentOmitted || details.cards.some((card) => card.finalTextTruncated)).toBe(
      true,
    );
    expect(Object.isFrozen(details.cards)).toBe(true);

    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "start",
        runs: [run()],
        cards: [run()],
      }),
    ).toBeUndefined();
  });

  it("preserves bounded immutable start receipts through projection and hostile decoding", () => {
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [],
      startEntries: [
        {
          index: 0,
          name: "auth-review",
          profile: "reviewer",
          status: "started",
          routeStatus: "selected",
          host: "herdr",
          runtime: "claude",
          model: "m".repeat(2_000),
          effort: "high",
          fastMode: true,
          candidateIndex: 2,
          runId: "agent-r1-1",
        },
        {
          index: 1,
          name: "future-review",
          profile: "future-profile",
          status: "failed",
          routeStatus: "unavailable",
        },
      ],
    });
    expect(details.startEntries?.[0]).toMatchObject({
      profile: "reviewer",
      routeStatus: "selected",
      host: "herdr",
      runtime: "claude",
      effort: "high",
      candidateIndex: 2,
    });
    expect(details.startEntries?.[0]?.model).toHaveLength(512);
    expect(details.startEntries?.[1]).toMatchObject({
      profile: "future-profile",
      routeStatus: "unavailable",
    });
    expect(Object.isFrozen(details.startEntries)).toBe(true);
    expect(decodeStartAwaitCardDetails(details)?.startEntries).toEqual(details.startEntries);

    expect(
      decodeStartAwaitCardDetails({
        version: 1,
        action: "start",
        cards: [],
        startEntries: [
          {
            index: 0,
            name: "hostile",
            status: "started",
            routeStatus: "selected",
            host: "unknown",
            runtime: "shell",
            model: "forged",
            effort: "extreme",
          },
        ],
      })?.startEntries?.[0],
    ).toMatchObject({ profile: "generalist", routeStatus: "unavailable" });
  });

  it("keeps hostile receipt identity and route fields inside the aggregate JSON bound", () => {
    const hostile = `${"\\".repeat(20_000)}${"\ud800".repeat(4_000)}`;
    const details = makeStartAwaitCardDetails({
      action: "start",
      runs: [],
      startEntries: Array.from({ length: 12 }, (_, index) => ({
        index,
        name: hostile,
        profile: hostile,
        status: "started" as const,
        routeStatus: "selected" as const,
        host: "local" as const,
        runtime: "pi" as const,
        model: hostile,
        effort: "high" as const,
        runId: hostile,
      })),
      startFailures: Array.from({ length: 12 }, (_, index) => ({
        index,
        name: hostile,
        code: hostile,
        message: hostile,
      })),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(details.startEntries).toHaveLength(12);
    expect(details.startEntries?.every((entry) => entry.profile.length > 0)).toBe(true);
    expect(details.startEntries?.every((entry) => entry.routeStatus === "selected")).toBe(true);
    expect(Object.isFrozen(details.startEntries)).toBe(true);
  });

  it("keeps non-card tool details compact, frozen, and serialization-bounded", () => {
    const hostile = `${"\\".repeat(2_000)}${"\ud800".repeat(500)}`;
    const details = makeCompactToolDetails({
      action: hostile,
      runs: Array.from({ length: 12 }, (_, index) => ({
        ...run(index + 1),
        id: `${index}-${hostile}`,
        name: hostile,
        model: hostile,
        finalText: hostile,
      })),
      profileIds: Array.from({ length: 20 }, () => hostile),
      fallbackProfile: "generalist",
      actionFailures: Array.from({ length: 12 }, (_, index) => ({
        id: `${index}-${hostile}`,
        code: hostile,
        message: hostile,
      })),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(details).toMatchObject({ version: 1 });
    expect(Object.isFrozen(details)).toBe(true);
    expect(decodeCompactToolDetails(details)).toMatchObject({
      action: details.action.slice(0, 32),
      runCount: 12,
    });
  });

  it("accepts only current-version persisted details and rejects malformed details", () => {
    expect(decodeStartAwaitCardDetails({ action: "start", runs: [run()] })).toBeUndefined();
    expect(() =>
      decodeStartAwaitCardDetails({
        version: 1,
        action: "await",
        cards: [{ id: { hostile: true }, state: "running" }],
      }),
    ).not.toThrow();
    expect(
      decodeStartAwaitCardDetails({
        version: 1,
        action: "await",
        cards: [{ id: { hostile: true }, state: "running" }],
      }),
    ).toBeUndefined();
    expect(decodeStartAwaitCardDetails({ action: "await", runs: "not-an-array" })).toBeUndefined();
    expect(
      decodeCompactToolDetails({
        version: 1,
        action: "models",
        profileIds: ["delegate"],
        fallbackProfile: "delegate",
      }),
    ).toMatchObject({ action: "models" });
  });

  it("preserves capabilities and unknown cost through the compact card fallback", () => {
    // Hostile escaping in identity/model/reason fields forces the compact
    // fallback stage without dropping the whole card list.
    const hostile = `${"\\".repeat(4_000)}`;
    const details = makeStartAwaitCardDetails({
      action: "await",
      runs: Array.from({ length: 12 }, (_, index) => ({
        ...run(index + 1),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
        selection: {
          source: "profile-candidate" as const,
          reason: hostile,
          skippedCandidates: [
            { candidate: hostile, code: "unavailable", reason: hostile },
            { candidate: hostile, code: "unavailable", reason: hostile },
          ],
        },
      })),
    });
    expect(details.cards.length).toBeGreaterThan(0);
    for (const card of details.cards) {
      // The compact stage was reached: provenance collapsed to its bounded form.
      expect(card.selection.skippedCandidates).toEqual([]);
      expect(card.selection.reason.length).toBeLessThanOrEqual(96);
      // Compact fallback keeps capability evidence so renderers stay neutral
      // instead of treating the run as definitely non-resumable.
      expect(card.capabilities).toEqual(["resume"]);
      // Unknown cost stays absent instead of becoming a fabricated known $0.
      expect(card.usage?.cost).toBeUndefined();
      expect(card.usage?.totalTokens).toBe(2);
    }
    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded?.cards[0]?.capabilities).toEqual(["resume"]);
    expect(decoded?.cards[0]?.usage?.cost).toBeUndefined();
  });

  it("round-trips a known zero cost distinctly from an unknown cost", () => {
    const details = makeStartAwaitCardDetails({ action: "await", runs: [run()] });
    expect(details.cards[0]?.usage?.cost).toBe(0);
    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded?.cards[0]?.usage?.cost).toBe(0);
  });
});
