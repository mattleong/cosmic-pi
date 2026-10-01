import { describe, expect, it, vi } from "vitest";
import { hasObjectRuntimeType } from "pi-cosmic-core";
import type { SubagentRunView } from "../src/run/model.ts";
import { formatStartResult } from "../src/tools/format.ts";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
  projectSubagentRunCard,
} from "../src/tools/details.ts";
import type { ProfileCandidateDiscovery as ProfileCandidateDetailsInput } from "../src/tools/model.ts";
import {
  SUBAGENT_CARD_DETAILS_VERSION,
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
  type SubagentStartEntry,
} from "../src/tools/details-schema.ts";

const run = (index = 1, cost?: number): SubagentRunView => {
  const usageBase = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
  const usage = cost === undefined ? usageBase : { ...usageBase, cost };
  return {
    id: `agent-r2-${index}`,
    name: `reader-${index}`,
    task: "Secret full task that must not persist in card details.",
    selection: {
      source: "profile-candidate",
      routeSource: "session",
      host: "local",
      runtime: "claude",
      closeOnReport: true,
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
    context: "fresh",
    writeIntent: "read-only",
    openaiFastMode: false,
    host: "local",
    runtime: "claude",
    closeOnReport: true,
    reportGeneration: 1,
    capabilities: ["steer", "interrupt", "parent-contact"],
    model: "provider/model",
    effort: "high",
    sessionId: "private-session",
    sessionFile: "/private/session.jsonl",
    startedAt: 1,
    endedAt: 2,
    lastActivityAt: 2,
    question: { requestId: "private-question", message: "May I continue?", createdAt: 2 },
    sessionEvents: [{ type: "assistant", text: "private transcript", createdAt: 2 }],
    finalText: `Report ${index}: ${"x".repeat(32_000)}`,
    usage,
  };
};

const profileCandidate = (overrides: Partial<ProfileCandidateDetailsInput> = {}) => ({
  host: "local" as const,
  runtime: "pi" as const,
  model: "openai/model",
  effort: "default" as const,
  context: "fresh" as const,
  writeIntent: "read-only" as const,
  openaiFastMode: false,
  closeOnReport: true,
  status: "eligible" as const,
  reason: "Ready.",
  ...overrides,
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

type Mutable<Value> =
  Value extends ReadonlyArray<infer Item>
    ? Array<Mutable<Item>>
    : Value extends object
      ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
      : Value;

const clone = <Value>(value: Value): Mutable<Value> => {
  // SAFETY: JSON parsing returns the mutable plain-data clone described by the recursive test type.
  return JSON.parse(JSON.stringify(value)) as Mutable<Value>;
};

const expectDeeplyFrozen = <ValueInput>(value: ValueInput): void => {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const child of value) expectDeeplyFrozen(child);
    return;
  }
  if (!hasObjectRuntimeType(value) || value === null) return;
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
};

const awaitWire = () => clone(makeAwaitDetails({ runs: [run()], awaitUntil: "all_finished" }));

const modelsDetails = () => {
  const details = clone(
    makeCompactToolDetails({
      action: "models",
      fallbackProfile: "generalist",
      profiles: [
        {
          id: "reviewer",
          description: "Review route.",
          source: "builtin",
          isDefault: false,
          defaultContext: "fresh",
          defaultWriteIntent: "read-only",
          candidates: [profileCandidate()],
        },
      ],
    }),
  );
  if (details.action !== "models") throw new Error("Expected model details.");
  return details;
};

/** Forged array whose length is readable but whose elements throw when read. */
const readGuarded = <Item>(items: Item[]) => {
  let reads = 0;
  const value = new Proxy(items, {
    get(target, key) {
      if (key === "length") return target.length;
      reads += 1;
      throw new Error("array element was read");
    },
  });
  return { value, reads: () => reads };
};

describe("persisted subagent details version 2", () => {
  it("retains known report availability through fitting without inventing historical absence", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      ...run(index + 1),
      reportStatus: "available" as const,
    }));
    const fitted = makeAwaitDetails({ runs, awaitUntil: "all_finished" });
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(48_000);
    expect(fitted.cards.every((card) => card.reportStatus === "available")).toBe(true);
    const historical = makeAwaitDetails({
      runs: [{ ...run(), finalText: undefined }],
      awaitUntil: "all_finished",
    });
    const restored = decodeStartAwaitCardDetails(historical);
    expect(
      restored && restored.action === "await" && restored.cards[0]?.reportStatus,
    ).toBeUndefined();
    for (const reportStatus of ["claimed", "delivered", "missing"] as const) {
      const details = makeAwaitDetails({
        runs: [{ ...run(), finalText: undefined, reportStatus }],
        awaitUntil: "all_finished",
      });
      expect(decodeStartAwaitCardDetails(details)).toMatchObject({ cards: [{ reportStatus }] });
      expect(JSON.stringify(details)).not.toContain("private transcript");
    }
  });
  it("projects warning provenance and bounds system evidence independently", () => {
    for (const [density, limit] of [
      ["full", 512],
      ["compact", 256],
      ["minimal", 96],
    ] as const) {
      const card = projectSubagentRunCard(
        {
          ...run(),
          warning: "Child advisory",
          warningSource: "child",
          systemWarning: "\u001b[31m" + "system ".repeat(500),
        },
        density,
      );
      expect(card.warning).toBe("Child advisory");
      expect(card.warningSource).toBe("child");
      expect(card.systemWarning?.length).toBeLessThanOrEqual(limit);
      expect(card.systemWarning).not.toContain("\u001b");
      expect(card.systemWarning).toContain("system");
    }
    const projected = makeCompactToolDetails({
      action: "status",
      runs: [{ ...run(), warningSource: "child", systemWarning: "System only" }],
    });
    const decoded = decodeCompactToolDetails(projected);
    expect(decoded && decoded.action !== "models" && decoded.cards[0]).toMatchObject({
      warningSource: "child",
      systemWarning: "System only",
    });
  });
  it("makes and decodes aggregate-bounded, deeply frozen private await cards", () => {
    const details = makeAwaitDetails({
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
    expectDeeplyFrozen(details);

    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded).toEqual(details);
    expect(JSON.stringify(decoded).length).toBeLessThanOrEqual(48_000);
    expectDeeplyFrozen(decoded);
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
    const details = makeAwaitDetails({
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

    const forged = clone(details);
    forged.cards[1]!.finalText = "Forged descendant report.";
    expect(decodeStartAwaitCardDetails(forged)).toBeUndefined();
  });

  it("keeps awaited target IDs aligned with compact cards during semantic fitting", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      ...run(index + 1),
      id: `${index}-${"i".repeat(1_020)}`,
      finalText: undefined,
      progress: "p".repeat(512),
      warning: "w".repeat(512),
      selection: {
        ...run(index + 1).selection,
        reason: "r".repeat(1_024),
        skippedCandidates: Array.from({ length: 8 }, (_, candidateIndex) => ({
          candidateIndex,
          candidate: `candidate-${candidateIndex}-${"c".repeat(64)}`,
          code: "unavailable",
          reason: "s".repeat(1_024),
        })),
      },
    }));
    const details = makeAwaitDetails({
      runs,
      awaitedRunIds: runs.map((candidate) => candidate.id),
      awaitUntil: "all_finished",
    });
    expect(details.cards).toHaveLength(12);
    expect(details.awaitedRunIds).toEqual(details.cards.map((card) => card.id));
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
  });

  it("orders list cards parent before child before applying the card bound", () => {
    const parent = { ...run(1), parentRunId: "root" };
    const child = { ...run(2), parentRunId: parent.id };
    const details = makeCompactToolDetails({ action: "list", runs: [child, parent] });
    expect(details.action).toBe("list");
    if (details.action !== "list") return;
    expect(details.cards.map((card) => card.id)).toEqual([parent.id, child.id]);
  });

  it("strips unknown keys without invoking their getters", () => {
    const source = clone(makeAwaitDetails({ runs: [run()], awaitUntil: "any_finished" }));
    const rootGetter = vi.fn(() => "private root value");
    const cardGetter = vi.fn(() => "private card value");
    Object.defineProperty(source, "privateRoot", { enumerable: true, get: rootGetter });
    Object.defineProperty(source.cards[0]!, "task", { enumerable: true, get: cardGetter });

    const decoded = decodeStartAwaitCardDetails(source);

    expect(decoded).toBeDefined();
    expect(rootGetter).not.toHaveBeenCalled();
    expect(cardGetter).not.toHaveBeenCalled();
    expect(decoded).not.toHaveProperty("privateRoot");
    expect(decoded?.action === "await" ? decoded.cards[0] : undefined).not.toHaveProperty("task");
  });

  it("returns undefined for known throwing getters and proxies", () => {
    const throwing = awaitWire();
    Object.defineProperty(throwing, "cards", {
      enumerable: true,
      get: () => {
        throw new Error("hostile getter");
      },
    });
    expect(() => decodeStartAwaitCardDetails(throwing)).not.toThrow();
    expect(decodeStartAwaitCardDetails(throwing)).toBeUndefined();

    const proxied = new Proxy(awaitWire(), {
      get() {
        throw new Error("hostile proxy");
      },
    });
    expect(() => decodeStartAwaitCardDetails(proxied)).not.toThrow();
    expect(decodeStartAwaitCardDetails(proxied)).toBeUndefined();
  });

  it("rejects oversized known arrays before reading their elements", () => {
    const cards = readGuarded(Array.from({ length: 13 }, () => run()));
    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "await",
        cards: cards.value,
        awaitUntil: "all_finished",
      }),
    ).toBeUndefined();
    expect(cards.reads()).toBe(0);

    const startEntries = readGuarded(Array.from({ length: 33 }, (_, index) => startedEntry(index)));
    expect(
      decodeStartAwaitCardDetails({
        version: 2,
        action: "start",
        startEntries: startEntries.value,
      }),
    ).toBeUndefined();
    expect(startEntries.reads()).toBe(0);

    const source = awaitWire();
    const capabilities = readGuarded(Array(8).fill("resume"));
    // SAFETY: The forged oversized array deliberately violates the decoded capability contract.
    source.cards[0]!.capabilities =
      capabilities.value as (typeof source.cards)[number]["capabilities"];
    expect(decodeStartAwaitCardDetails(source)).toBeUndefined();
    expect(capabilities.reads()).toBe(0);
  });

  it("rejects old versions, unsupported versions, wrong discriminants, and wrong shapes", () => {
    const awaitDetails = awaitWire();
    expect(decodeStartAwaitCardDetails({ ...awaitDetails, version: 1 })).toBeUndefined();
    expect(decodeStartAwaitCardDetails({ ...awaitDetails, version: 3 })).toBeUndefined();
    expect(
      decodeStartAwaitCardDetails({ ...awaitDetails, awaitedRunIds: ["missing-run"] }),
    ).toBeUndefined();
    expect(decodeStartAwaitCardDetails({ ...awaitDetails, action: "start" })).toBeUndefined();
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

  it("rejects malformed fields and children without partial salvage", () => {
    const malformedCard = awaitWire();
    // SAFETY: This forged child deliberately violates the persisted card model type.
    malformedCard.cards.push({ ...malformedCard.cards[0]!, model: 42 } as never);
    expect(decodeStartAwaitCardDetails(malformedCard)).toBeUndefined();

    const malformedCapability = awaitWire();
    // SAFETY: This forged enum value deliberately violates the capability schema.
    malformedCapability.cards[0]!.capabilities = ["resume", "forged"] as never;
    expect(decodeStartAwaitCardDetails(malformedCapability)).toBeUndefined();

    const malformedFailure = clone(
      makeCompactToolDetails({
        action: "send",
        runs: [run()],
        actionFailures: [{ id: "missing", message: "Missing." }],
      }),
    );
    if (malformedFailure.action !== "models")
      malformedFailure.actionFailures = [
        ...(malformedFailure.actionFailures ?? []),
        // SAFETY: This forged child deliberately violates the action-failure message type.
        { id: "bad", message: 42 } as never,
      ];
    expect(decodeCompactToolDetails(malformedFailure)).toBeUndefined();

    const malformedProfile = modelsDetails();
    // SAFETY: This forged child deliberately violates the profile-candidate reason type.
    malformedProfile.profiles[0]!.candidates[0]!.reason = 42 as never;
    expect(decodeCompactToolDetails(malformedProfile)).toBeUndefined();
  });

  it("requires structured model candidates, applies cross-field policy, and strips private fields", () => {
    const details = modelsDetails();
    const rawCandidate = details.profiles[0]!.candidates[0]!;

    const missing = clone(details);
    // SAFETY: This forged mutable view removes a required wire field for decoder coverage.
    delete (missing.profiles[0]!.candidates[0] as { model?: string }).model;
    expect(decodeCompactToolDetails(missing)).toBeUndefined();

    const crossField = clone(details);
    Object.assign(crossField.profiles[0]!.candidates[0]!, {
      host: "local",
      runtime: "claude",
      model: "parent",
    });
    expect(decodeCompactToolDetails(crossField)).toBeUndefined();

    const oldProse = clone(details);
    // SAFETY: This cast injects the removed prose card shape into a current-version wire fixture.
    oldProse.profiles[0]!.candidates[0] = {
      order: 1,
      candidate: "local/pi/openai/model:default:fresh:read-only",
      status: "eligible",
      reason: "Ready.",
    } as never;
    expect(decodeCompactToolDetails(oldProse)).toBeUndefined();

    let privateReads = 0;
    Object.defineProperty(rawCandidate, "privatePath", {
      enumerable: true,
      get: () => {
        privateReads += 1;
        return "/private/project";
      },
    });
    const stripped = decodeCompactToolDetails(details);
    expect(stripped).toBeDefined();
    expect(JSON.stringify(stripped)).not.toContain("privatePath");
    expect(JSON.stringify(stripped)).not.toContain("/private/project");
    expect(privateReads).toBe(0);
    expectDeeplyFrozen(stripped);
  });

  it("requires exact request-ordered start entries and matching failures", () => {
    const details = makeStartDetails({
      startEntries: [
        {
          ...startedEntry(0, "same-name"),
          warning:
            "The primary candidate was unavailable; selected the declared local Pi fallback.",
        },
        {
          index: 1,
          name: "same-name",
          profile: "reviewer",
          status: "failed",
          routeStatus: "unavailable",
        },
      ],
      startFailures: [{ index: 1, name: "same-name", code: "unavailable", message: "No route." }],
    });

    expect(details).not.toHaveProperty("cards");
    expect(details.startEntries.map((entry) => [entry.index, entry.name])).toEqual([
      [0, "same-name"],
      [1, "same-name"],
    ]);
    expect(details.startEntries[0]).toMatchObject({
      runId: "agent-r2-1",
      warning: expect.stringContaining("declared local Pi fallback"),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expectDeeplyFrozen(details);

    const reordered = clone(details);
    reordered.startEntries.reverse();
    expect(decodeStartAwaitCardDetails(reordered)).toBeUndefined();

    const missingFailure = clone(details);
    delete missingFailure.startFailures;
    expect(decodeStartAwaitCardDetails(missingFailure)).toBeUndefined();

    const forgedFailure = clone(details);
    forgedFailure.startFailures![0]!.index = 0;
    expect(decodeStartAwaitCardDetails(forgedFailure)).toBeUndefined();
  });

  it("fits and strictly decodes 32 dense selected and unavailable start failures in receipt order", () => {
    // Every fourth entry is an unavailable route whose warning fitting must drop before strict
    // decode; the rest stay selected so the payload still escalates to minimal density.
    const entries: SubagentStartEntry[] = Array.from({ length: 32 }, (_, index) => {
      const identity = {
        index,
        name: `launch-${index}-${"n".repeat(300)}`,
        profile: "p".repeat(64),
        status: "failed" as const,
        warning: "w".repeat(2_000),
      };
      return index % 4 === 3
        ? { ...identity, routeStatus: "unavailable" as const }
        : {
            ...identity,
            routeStatus: "selected" as const,
            host: "local" as const,
            runtime: "pi" as const,
            model: "m".repeat(512),
            effort: "high" as const,
            openaiFastMode: false,
            candidateIndex: index,
          };
    });
    const startFailures = Array.from({ length: 32 }, (_, index) => ({
      index,
      name: `launch-${index}-${"n".repeat(300)}`,
      code: "c".repeat(128),
      message: "failure ".concat("m".repeat(5_000)),
    })).reverse();

    const details = makeStartDetails({ startEntries: entries, startFailures });
    const serialized = JSON.stringify(details);

    expect(details.startEntries).toHaveLength(32);
    expect(details.startFailures).toHaveLength(32);
    expect(details.startEntries.map((entry) => entry.index)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(details.startFailures?.map((failure) => failure.index)).toEqual(
      Array.from({ length: 32 }, (_, index) => index),
    );
    expect(details.startEntries[0]).toMatchObject({ candidateIndex: 0 });
    expect(details.startEntries[0]?.name.length).toBeLessThanOrEqual(48);
    expect(serialized.length).toBeLessThanOrEqual(48_000);
    expectDeeplyFrozen(details);

    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded).toEqual(details);
    expectDeeplyFrozen(decoded);
  });

  it("persists admitted-run recovery in request order and rejects forged dispositions", () => {
    const failedSelected = (index: number, name: string): SubagentStartEntry => ({
      index,
      name,
      profile: "reviewer",
      status: "failed",
      routeStatus: "selected",
      host: "local",
      runtime: "pi",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      openaiFastMode: false,
      candidateIndex: index,
    });
    const details = makeStartDetails({
      startEntries: [failedSelected(0, "first"), failedSelected(1, "second")],
      startFailures: [
        {
          index: 1,
          name: "second",
          code: "start_outcome_uncertain",
          message: "Outcome uncertain.",
          admittedRun: {
            runId: "agent-r2-2",
            cleanupDisposition: "confirmed",
            retryDisposition: "blocked",
            remainingCandidateCount: 1,
            hasRemainingCandidate: true,
          },
        },
        {
          index: 0,
          name: "first",
          code: "prompt_rejected",
          message: "Prompt rejected.",
          admittedRun: {
            runId: "agent-r2-1",
            cleanupDisposition: "confirmed",
            retryDisposition: "eligible",
            remainingCandidateCount: 2,
            hasRemainingCandidate: true,
          },
        },
      ],
    });

    expect(details.startFailures?.map((failure) => failure.index)).toEqual([0, 1]);
    expect(details.startFailures).toMatchObject([
      {
        admittedRun: {
          runId: "agent-r2-1",
          cleanupDisposition: "confirmed",
          retryDisposition: "eligible",
          remainingCandidateCount: 2,
          hasRemainingCandidate: true,
        },
      },
      {
        admittedRun: {
          runId: "agent-r2-2",
          retryDisposition: "blocked",
        },
      },
    ]);
    expect(decodeStartAwaitCardDetails(details)).toEqual(details);
    expectDeeplyFrozen(details);
    const formatted = formatStartResult([], details.startFailures ?? []);
    expect(formatted).toContain("admitted agent-r2-1 · cleanup confirmed · retry eligible");
    expect(formatted).toContain('subagent_lifecycle({ action: "retry", runIds: ["agent-r2-1"] })');
    expect(formatted).toContain("retry blocked");

    const forgedEligibility = clone(details);
    forgedEligibility.startFailures![0]!.admittedRun!.cleanupDisposition = "pending";
    expect(decodeStartAwaitCardDetails(forgedEligibility)).toBeUndefined();

    const forgedRemaining = clone(details);
    forgedRemaining.startFailures![0]!.admittedRun!.hasRemainingCandidate = false;
    expect(decodeStartAwaitCardDetails(forgedRemaining)).toBeUndefined();

    const reordered = clone(details);
    reordered.startFailures!.reverse();
    expect(decodeStartAwaitCardDetails(reordered)).toBeUndefined();
  });

  it("fits hostile start identities without dropping entries or failures", () => {
    const hostile = `${"\\".repeat(20_000)}${"\ud800".repeat(4_000)}`;
    const entries: SubagentStartEntry[] = Array.from({ length: 12 }, (_, index) => ({
      ...startedEntry(index, hostile),
      profile: hostile,
      model: hostile,
      runId: `${index}-${hostile}`,
    }));
    entries[5] = {
      index: 5,
      name: hostile,
      profile: hostile,
      status: "failed",
      routeStatus: "unavailable",
    };
    const details = makeStartDetails({
      startEntries: entries,
      startFailures: [{ index: 5, name: hostile, code: hostile, message: hostile }],
    });

    expect(details.startEntries).toHaveLength(12);
    expect(details.startFailures).toHaveLength(1);
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
  });

  it("only labels await omissions as report-only without source errors or input uncertainty", () => {
    const runs = [run(1), run(2)];
    expect(makeAwaitDetails({ runs, awaitUntil: "all_finished" }).reportsOnlyOmitted).toBe(true);
    expect(
      makeAwaitDetails({ runs, awaitUntil: "all_finished", contentOmitted: true })
        .reportsOnlyOmitted,
    ).toBeUndefined();
    expect(
      makeAwaitDetails({
        runs: [{ ...runs[0]!, error: "failure" }, runs[1]!],
        awaitUntil: "all_finished",
      }).reportsOnlyOmitted,
    ).toBeUndefined();
  });

  it("preserves omission evidence, capabilities, routes, questions, and cost semantics", () => {
    const details = makeAwaitDetails({
      runs: [run(1, undefined), run(2, 0)],
      awaitUntil: "all_finished",
    });

    expect(details.contentOmitted).toBe(true);
    expect(details.cards[0]).toMatchObject({
      finalTextTruncated: true,
      capabilities: ["steer", "interrupt", "parent-contact"],
      host: "local",
      runtime: "claude",
      model: "provider/model",
      closeOnReport: true,
      question: { message: "May I continue?" },
    });
    expect(details.cards[0]?.usage.cost).toBeUndefined();
    expect(details.cards[1]?.usage.cost).toBe(0);

    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded?.action === "await" ? decoded.cards[0]?.usage.cost : 1).toBeUndefined();
    expect(decoded?.action === "await" ? decoded.cards[1]?.usage.cost : undefined).toBe(0);
  });

  it("makes discriminated non-start details without removed root wire fields", () => {
    const status = makeCompactToolDetails({ action: "status", runs: [run()] });
    expect(status).toMatchObject({ version: 2, action: "status", runCount: 1 });
    expect(status).not.toHaveProperty("runIds");
    expect(status).not.toHaveProperty("profileIds");
    expect(status).not.toHaveProperty("timedOut");
    expect(status).not.toHaveProperty("attentionRequired");
    expect(JSON.stringify(status).length).toBeLessThanOrEqual(48_000);
    expect(decodeCompactToolDetails(status)).toEqual(status);

    expect(decodeCompactToolDetails({ ...clone(status), action: "models" })).toBeUndefined();
    expect(
      decodeCompactToolDetails({ ...clone(status), profiles: [], fallbackProfile: "generalist" }),
    ).toBeUndefined();
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
    const details = makeCompactToolDetails({ action: "claims", runs: [claimed] });
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

    const oldCard = makeCompactToolDetails({ action: "status", runs: [run()] });
    expect(decodeCompactToolDetails(oldCard)).toEqual(oldCard);
  });

  it("fits legal claim-heavy cards by preserving counts and explicit omission", () => {
    const writeClaims = Array.from(
      { length: 64 },
      (_, index) => `src/${index}-${"x".repeat(490)}.ts`,
    );
    const claimed = (index: number): SubagentRunView => ({
      ...run(index),
      writeIntent: "writer",
      writeClaims,
      writeAudit: { observedFileWrites: [], violations: [], bashWriteHints: 0 },
    });
    const details = makeCompactToolDetails({
      action: "status",
      runs: [claimed(1), claimed(2)],
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    if (details.action === "models") throw new Error("Expected run-card details.");
    expect(details.cards).toHaveLength(2);
    expect(details.cards[0]).toMatchObject({
      writeClaimCount: 64,
      writeClaimsOmitted: true,
    });
    expect(details.cards[0]?.writeClaims?.length).toBeLessThan(64);
    expect(decodeCompactToolDetails(details)).toEqual(details);
  });

  it("bounds profile route details through the shared semantic selector", () => {
    const hostile = `${"\\".repeat(2_000)}${"\ud800".repeat(500)}`;
    const details = makeCompactToolDetails({
      action: "models",
      fallbackProfile: "generalist",
      profiles: (
        ["scout", "researcher", "planner", "worker", "reviewer", "oracle", "generalist"] as const
      ).map((id) => ({
        id,
        description: hostile,
        source: "session" as const,
        isDefault: id === "generalist",
        defaultContext: "fresh" as const,
        defaultWriteIntent: "read-only" as const,
        defaultEffort: "high" as const,
        candidates: Array.from({ length: 32 }, () =>
          profileCandidate({ model: hostile, reason: hostile }),
        ),
      })),
    });

    expect(details.action).toBe("models");
    if (details.action !== "models") throw new Error("Expected model details.");
    expect(details.profiles).toHaveLength(7);
    expect(details.profiles[0]?.candidates).toHaveLength(32);
    expect(details.profiles.flatMap((profile) => profile.candidates)).toHaveLength(7 * 32);
    expect(details.contentOmitted).toBe(true);
    const projected = details.profiles[0]!.candidates[0]!;
    expect(projected).toMatchObject({
      host: "local",
      runtime: "pi",
      effort: "default",
      context: "fresh",
      writeIntent: "read-only",
      openaiFastMode: false,
      closeOnReport: true,
      status: "eligible",
    });
    expect(projected).not.toHaveProperty("order");
    expect(projected).not.toHaveProperty("candidate");
    expect(projected).not.toHaveProperty("effectiveContext");
    expect(projected.model).toMatch(/^[\x20-\x7e]+$/);
    expect(projected.reason).toMatch(/^[\x20-\x7e]+$/);
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expectDeeplyFrozen(details);
  });

  it("rejects canonical decoded details larger than 48,000 characters", () => {
    const valid = awaitWire();
    valid.cards = Array.from({ length: 12 }, (_, index) => ({
      ...valid.cards[0]!,
      id: `agent-${index}`,
      finalText: "x".repeat(20_000),
    }));
    valid.awaitedRunIds = valid.cards.map((card) => card.id);
    expect(decodeStartAwaitCardDetails(valid)).toBeUndefined();

    Object.defineProperty(valid, "unknownLargeValue", {
      enumerable: true,
      value: "private".repeat(20_000),
    });
    delete valid.cards[0]!.finalText;
    valid.cards = [valid.cards[0]!];
    valid.awaitedRunIds = [valid.cards[0]!.id];
    const stripped = decodeStartAwaitCardDetails(valid);
    expect(stripped).toBeDefined();
    expect(JSON.stringify(stripped).length).toBeLessThanOrEqual(48_000);
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

  it("fits dense run failures while preserving targets and pending questions", () => {
    const runs = Array.from({ length: 12 }, (_, index) => ({
      ...auditedRun(true),
      id: `agent-${index}`,
      question: { requestId: `q-${index}`, message: "q".repeat(3_000), createdAt: 1 },
      progress: "p".repeat(1_000),
      warning: "w".repeat(1_000),
      finalText: "private report".repeat(2_000),
    }));
    const details = makeCompactToolDetails({
      action: "send",
      runs,
      actionFailures: [{ id: "missing-agent", code: "not_found", message: "m".repeat(5_000) }],
    });
    if (details.action !== "send") throw new Error("Expected run details.");
    expect(details.cards.map(({ id }) => id)).toEqual(runs.map(({ id }) => id));
    expect(details.cards.every((card) => Boolean(card.question?.message))).toBe(true);
    expect(details.actionFailures?.[0]).toMatchObject({ id: "missing-agent", code: "not_found" });
    expect(details.contentOmitted).toBe(true);
    expect(JSON.stringify(details)).not.toContain("private report");
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(decodeCompactToolDetails(details)).toEqual(details);
    expect(Object.isFrozen(details)).toBe(true);
  });
});
