import { describe, expect, it, vi } from "vitest";
import * as Predicate from "effect/Predicate";
import type { SubagentRunView } from "../src/run/model.ts";
import { formatStartResult } from "../src/tools/format.ts";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
} from "../src/tools/details.ts";
import { projectSubagentRunCard } from "../src/tools/details-projection.ts";
import type { ProfileCandidateDiscovery as ProfileCandidateDetailsInput } from "../src/tools/model.ts";
import {
  SUBAGENT_CARD_DETAILS_VERSION,
  type SubagentStartEntry,
} from "../src/tools/details-schema.ts";
import {
  decodeCompactToolDetails,
  decodeStartAwaitCardDetails,
} from "../src/tools/details-decode.ts";
import { view } from "./fixtures/run-view.ts";
import { stringContaining } from "./support/matchers.ts";

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

type ModelsDetails = ReturnType<typeof modelsDetails>;
type ModelsCandidate = ModelsDetails["profiles"][number]["candidates"][number];

const withFirstCandidate = <Next>(
  details: ModelsDetails,
  next: (candidate: ModelsCandidate) => Next,
) => ({
  ...details,
  profiles: replaceAt(details.profiles, 0, (profile) => ({
    ...profile,
    candidates: replaceAt(profile.candidates, 0, next),
  })),
});

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
      restored === undefined
        ? undefined
        : restored.action === "await" && restored.cards[0]?.reportStatus,
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

    const forged = {
      ...details,
      cards: replaceAt(details.cards, 1, (card) => ({
        ...card,
        finalText: "Forged descendant report.",
      })),
    };
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
        skippedCandidates: Array.from({ length: 8 }, (_slot, candidateIndex) => ({
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
    expect(decodeStartAwaitCardDetails(throwing)).toBeUndefined();

    const proxied = new Proxy(awaitWire(), {
      get() {
        throw new Error("hostile proxy");
      },
    });
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
    const capabilities = readGuarded(Array.from({ length: 8 }, () => "resume"));
    const guarded = {
      ...source,
      cards: replaceAt(source.cards, 0, (card) => ({ ...card, capabilities: capabilities.value })),
    };
    expect(decodeStartAwaitCardDetails(guarded)).toBeUndefined();
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
    const wire = awaitWire();
    const malformedCard = { ...wire, cards: [...wire.cards, { ...wire.cards[0]!, model: 42 }] };
    expect(decodeStartAwaitCardDetails(malformedCard)).toBeUndefined();

    const malformedCapability = {
      ...wire,
      cards: replaceAt(wire.cards, 0, (card) => ({ ...card, capabilities: ["resume", "forged"] })),
    };
    expect(decodeStartAwaitCardDetails(malformedCapability)).toBeUndefined();

    const failures = makeCompactToolDetails({
      action: "send",
      runs: [run()],
      actionFailures: [{ id: "missing", message: "Missing." }],
    });
    if (failures.action === "models") throw new Error("Expected run details.");
    const malformedFailure = {
      ...failures,
      actionFailures: [...(failures.actionFailures ?? []), { id: "bad", message: 42 }],
    };
    expect(decodeCompactToolDetails(malformedFailure)).toBeUndefined();

    const malformedProfile = withFirstCandidate(modelsDetails(), (candidate) => ({
      ...candidate,
      reason: 42,
    }));
    expect(decodeCompactToolDetails(malformedProfile)).toBeUndefined();
  });

  it("requires structured model candidates, applies cross-field policy, and strips private fields", () => {
    const details = modelsDetails();
    const rawCandidate = details.profiles[0]!.candidates[0]!;

    const missing = withFirstCandidate(details, ({ model: _model, ...candidate }) => candidate);
    expect(decodeCompactToolDetails(missing)).toBeUndefined();

    const crossField = clone(details);
    Object.assign(crossField.profiles[0]!.candidates[0]!, {
      host: "local",
      runtime: "claude",
      model: "parent",
    });
    expect(decodeCompactToolDetails(crossField)).toBeUndefined();

    const oldProse = withFirstCandidate(details, () => ({
      order: 1,
      candidate: "local/pi/openai/model:default:fresh:read-only",
      status: "eligible",
      reason: "Ready.",
    }));
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
    expect(isDeeplyFrozen(stripped)).toBe(true);
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
      warning: stringContaining("declared local Pi fallback"),
    });
    expect(JSON.stringify(details).length).toBeLessThanOrEqual(48_000);
    expect(isDeeplyFrozen(details)).toBe(true);

    const reordered = { ...details, startEntries: details.startEntries.toReversed() };
    expect(decodeStartAwaitCardDetails(reordered)).toBeUndefined();

    const { startFailures: _startFailures, ...missingFailure } = details;
    expect(decodeStartAwaitCardDetails(missingFailure)).toBeUndefined();

    const forgedFailure = {
      ...details,
      startFailures: replaceAt(details.startFailures ?? [], 0, (failure) => ({
        ...failure,
        index: 0,
      })),
    };
    expect(decodeStartAwaitCardDetails(forgedFailure)).toBeUndefined();
  });

  it("fits and strictly decodes 32 dense selected and unavailable start failures in receipt order", () => {
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
    })).toReversed();

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
    expect(isDeeplyFrozen(details)).toBe(true);

    const decoded = decodeStartAwaitCardDetails(details);
    expect(decoded).toEqual(details);
    expect(isDeeplyFrozen(decoded)).toBe(true);
  });

  it("persists admitted-run recovery in request order and rejects forged dispositions", () => {
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
    expect(isDeeplyFrozen(details)).toBe(true);
    const formatted = formatStartResult([], details.startFailures ?? []);
    expect(formatted).toContain("admitted agent-r2-1 · cleanup confirmed · retry eligible");
    expect(formatted).toContain('subagent_lifecycle({ action: "retry", runIds: ["agent-r2-1"] })');
    expect(formatted).toContain("retry blocked");

    const withFirstAdmitted = <Patch>(patch: Patch) => ({
      ...details,
      startFailures: replaceAt(details.startFailures ?? [], 0, (failure) => ({
        ...failure,
        admittedRun: { ...failure.admittedRun, ...patch },
      })),
    });
    const forgedEligibility = withFirstAdmitted({ cleanupDisposition: "pending" });
    expect(decodeStartAwaitCardDetails(forgedEligibility)).toBeUndefined();

    const forgedRemaining = withFirstAdmitted({ hasRemainingCandidate: false });
    expect(decodeStartAwaitCardDetails(forgedRemaining)).toBeUndefined();

    const reordered = { ...details, startFailures: (details.startFailures ?? []).toReversed() };
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

  it("only labels await omissions as report-only without source errors", () => {
    const runs = [run(1), run(2)];
    expect(makeAwaitDetails({ runs, awaitUntil: "all_finished" }).reportsOnlyOmitted).toBe(true);
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
    expect(status).not.toHaveProperty("attentionRequired");
    expect(JSON.stringify(status).length).toBeLessThanOrEqual(48_000);
    expect(decodeCompactToolDetails(status)).toEqual(status);

    expect(decodeCompactToolDetails({ ...status, action: "models" })).toBeUndefined();
    expect(
      decodeCompactToolDetails({ ...status, profiles: [], fallbackProfile: "generalist" }),
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
    expect(isDeeplyFrozen(details)).toBe(true);
  });

  it("rejects canonical decoded details larger than 48,000 characters", () => {
    const wire = awaitWire();
    const card = wire.cards[0]!;
    const cards = Array.from({ length: 12 }, (_, index) => ({
      ...card,
      id: `agent-${index}`,
      finalText: "x".repeat(20_000),
    }));
    const oversized = { ...wire, cards, awaitedRunIds: cards.map((entry) => entry.id) };
    expect(decodeStartAwaitCardDetails(oversized)).toBeUndefined();

    const { finalText: _finalText, ...reportless } = card;
    const valid = { ...wire, cards: [reportless], awaitedRunIds: [card.id] };
    Object.defineProperty(valid, "unknownLargeValue", {
      enumerable: true,
      value: "private".repeat(20_000),
    });
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
      question: { requestId: `q-${index}`, message: "q".repeat(3_000) },
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
