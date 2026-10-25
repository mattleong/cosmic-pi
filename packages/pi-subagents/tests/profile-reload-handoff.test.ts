import { afterEach, describe, expect, it } from "vitest";
import { profileReloadHandoff as handoff } from "../src/application/profile-reload-handoff.ts";
import { restoredSessionProfileSnapshot } from "../src/profiles/session-overrides.ts";
import { resolveTestConfig } from "./fixtures/profile-settings-inspection.ts";
import {
  completeBaseline,
  declaredCandidate,
  profileCandidate as candidate,
} from "./fixtures/profiles.ts";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";

const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

afterEach(() => handoff.clear());

const slotPresent = () => Rec.has<string | symbol, unknown>(globalThis, reloadSlot);
const writeSlot = (descriptor: PropertyDescriptor) =>
  Object.defineProperty(globalThis, reloadSlot, {
    configurable: true,
    enumerable: true,
    writable: true,
    ...descriptor,
  });
const completeSeed = (revision = 0) => ({
  revision,
  overrides: {},
  baseline: completeBaseline("global"),
});
const capture = (sessionKey: string) => handoff.capture(sessionKey)?.restore;
const SESSION_ONE = { version: 2, sessionKey: "session-one" } as const;
/** A candidate carrying a field this version no longer knows. */
const retiredCandidate = (model: string, writeIntent: "read-only" | "writer" = "read-only") => ({
  ...candidate(model, { writeIntent }),
  runtime: "local",
});

const writerConfig = () =>
  resolveTestConfig(
    {
      version: 6,
      defaultProfileSet: "default",
      profileSets: {
        default: {
          profiles: {
            worker: declaredCandidate("openai/config-worker", {
              writeIntent: "writer",
            }),
            reviewer: declaredCandidate("openai/config-reviewer"),
          },
        },
      },
      nesting: { maxDirectChildren: 6, maxDepth: 3 },
    },
    undefined,
  );

describe("profile reload handoff", () => {
  it("keeps the overrides that still decode and drops each invalid one once", () => {
    writeSlot({
      value: {
        ...SESSION_ONE,
        seed: {
          revision: 7,
          overrides: {
            reviewer: { candidates: [candidate("openai/kept")] },
            worker: {
              candidates: [retiredCandidate("openai/retired", "writer")],
            },
          },
          delegation: "eager",
          nesting: { maxDepth: 2 },
          baseline: completeBaseline("global"),
        },
      },
    });

    const restore = capture("session-one");
    expect(slotPresent()).toBe(false);
    expect(restore?.seed).toMatchObject({
      revision: 7,
      overrides: { reviewer: { candidates: [candidate("openai/kept")] } },
      nesting: { maxDepth: 2 },
      baseline: completeBaseline("global"),
    });
    expect(restore?.seed.overrides.worker).toBeUndefined();
    expect(restore?.lost).toEqual({
      unreadable: false,
      profiles: [{ profile: "worker", from: "override", admittedWriter: true }],
      baseline: false,
      delegation: true,
      nesting: false,
    });
    expect(handoff.capture("session-one")).toBeUndefined();
  });

  it("replaces an invalid baseline with the configuration without widening write intent", () => {
    const baseline = completeBaseline("global");
    writeSlot({
      value: {
        ...SESSION_ONE,
        seed: {
          revision: 3,
          overrides: {},
          baseline: {
            ...baseline,
            profiles: Rec.map(baseline.profiles, (route) => ({
              candidates: Arr.map(route.candidates, (entry) => ({
                ...entry,
                runtime: "local",
              })),
            })),
          },
        },
      },
    });
    const restore = capture("session-one");
    if (!restore) throw new Error("Expected a restore");
    const { snapshot, resets } = restoredSessionProfileSnapshot(writerConfig(), restore);

    // The lost baseline let no profile write, so the configured writer stays read-only.
    expect(snapshot.effectiveConfig.profiles.worker.candidates).toEqual([
      expect.objectContaining({
        model: "openai/config-worker",
        writeIntent: "read-only",
      }),
    ]);
    expect(snapshot.effectiveConfig.profileSources.worker).toBe("session");
    expect(snapshot.effectiveConfig.profiles.reviewer.candidates[0]?.model).toBe(
      "openai/config-reviewer",
    );
    expect(resets).toMatchObject({
      routes: [],
      readOnly: ["worker"],
      profileSet: true,
    });
  });

  it("lets a configured writer through when the lost route admitted one", () => {
    writeSlot({
      value: {
        ...SESSION_ONE,
        seed: {
          ...completeSeed(1),
          overrides: {
            worker: {
              candidates: [retiredCandidate("openai/retired", "writer")],
            },
          },
        },
      },
    });
    const restore = capture("session-one");
    if (!restore) throw new Error("Expected a restore");
    const { snapshot, resets } = restoredSessionProfileSnapshot(writerConfig(), restore);

    expect(snapshot.effectiveConfig.profiles.worker).toEqual(
      completeBaseline("global").profiles.worker,
    );
    expect(snapshot.effectiveConfig.profileSources.worker).toBe("global");
    expect(resets).toMatchObject({ routes: ["worker"], readOnly: [] });
  });

  it("fails invalid nesting limits closed to their minimum", () => {
    for (const [nesting, expected] of [
      [
        { maxDirectChildren: "many", maxDepth: 2 },
        { maxDirectChildren: 1, maxDepth: 2 },
      ],
      [
        { maxDepth: 2, maxActiveRuns: null },
        { maxDirectChildren: 6, maxActiveRuns: 1 },
      ],
      ["unlimited", { maxDirectChildren: 1, maxDepth: 0, maxActiveRuns: 1 }],
    ] as const) {
      writeSlot({
        value: { ...SESSION_ONE, seed: { ...completeSeed(), nesting } },
      });
      const restore = capture("session-one");
      if (!restore) throw new Error("Expected a restore");
      const { snapshot, resets } = restoredSessionProfileSnapshot(writerConfig(), restore);

      expect(resets?.nesting).toBe(true);
      expect(snapshot.effectiveConfig.nesting).toMatchObject(expected);
    }
  });

  it("doesn't report nesting limits that an unknown key left unchanged", () => {
    writeSlot({
      value: { ...SESSION_ONE, seed: { ...completeSeed(), nesting: { maxDepth: 2, extra: 1 } } },
    });
    const restore = capture("session-one");
    if (!restore) throw new Error("Expected a restore");
    const { snapshot, resets } = restoredSessionProfileSnapshot(writerConfig(), restore);

    expect(resets).toBeUndefined();
    expect(snapshot.effectiveConfig.nesting).toMatchObject({ maxDepth: 2 });
  });

  it("puts an unapplied handoff back unchanged so the next reload decodes it the same way", () => {
    const envelope = {
      ...SESSION_ONE,
      seed: { ...completeSeed(), overrides: { worker: { candidates: [retiredCandidate("x")] } } },
    };
    writeSlot({ value: envelope });
    const first = handoff.capture("session-one");
    expect(slotPresent()).toBe(false);
    first?.retain();

    expect(Object.getOwnPropertyDescriptor(globalThis, reloadSlot)?.value).toBe(envelope);
    expect(capture("session-one")?.lost).toEqual(first?.restore.lost);
  });

  it("fails closed when the session's own handoff can't be read at all", () => {
    writeSlot({
      value: { version: 99, sessionKey: "session-one", seed: completeSeed() },
    });
    const restore = capture("session-one");
    expect(slotPresent()).toBe(false);
    if (!restore) throw new Error("Expected a restore");
    const { snapshot, resets } = restoredSessionProfileSnapshot(writerConfig(), restore);

    expect(snapshot.effectiveConfig.profiles.worker.candidates[0]?.writeIntent).toBe("read-only");
    expect(snapshot.effectiveConfig.nesting).toMatchObject({
      maxDirectChildren: 1,
      maxDepth: 0,
    });
    expect(resets).toMatchObject({ unreadable: true, profileSet: true, nesting: true });
  });

  it("round-trips a valid handoff unchanged", () => {
    const seed = {
      revision: 4,
      overrides: { reviewer: { candidates: [candidate("openai/override")] } },
      nesting: { maxDepth: 2 },
      delegation: "orchestration" as const,
      baseline: completeBaseline("global", "openai/baseline"),
    };
    handoff.publish("session-one", seed);

    const restore = capture("session-one");
    expect(restore?.seed).toEqual(seed);
    expect(restore?.seed).not.toBe(seed);
    if (!restore) throw new Error("Expected a restore");
    expect(restoredSessionProfileSnapshot(writerConfig(), restore).resets).toBeUndefined();
  });

  it("restores nothing from malformed or foreign envelopes, and clears them", () => {
    for (const envelope of [
      { malformed: true },
      { version: 2, sessionKey: "different-session", seed: completeSeed() },
    ]) {
      writeSlot({ value: envelope });
      expect(handoff.capture("session-one")).toBeUndefined();
      expect(slotPresent()).toBe(false);
    }
  });
});
