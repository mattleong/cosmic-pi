import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IncompatibleProfileReloadHandoffError,
  profileReloadHandoff as handoff,
  profileReloadSessionKey,
} from "../src/application/profile-reload-handoff.ts";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";

const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

afterEach(() => handoff.clear());

const slotPresent = () => Object.hasOwn(globalThis, reloadSlot);
const slotDescriptor = () => Object.getOwnPropertyDescriptor(globalThis, reloadSlot);
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

describe("profile reload handoff", () => {
  it("preserves incompatible same-session handoffs across module replacements", () => {
    for (const location of ["override", "baseline"] as const) {
      const baseline = completeBaseline("global");
      const remote = { ...candidate("openai/remote"), host: "herdr" };
      const seed =
        location === "override"
          ? { ...completeSeed(7), overrides: { worker: { candidates: [remote] } } }
          : {
              ...completeSeed(7),
              baseline: {
                ...baseline,
                profiles: { ...baseline.profiles, worker: { candidates: [remote] } },
              },
            };
      const envelope = { version: 2, sessionKey: "session-one", seed };
      writeSlot({ value: envelope });
      for (let replacement = 0; replacement < 3; replacement += 1) {
        expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
        expect(slotDescriptor()?.value).toBe(envelope);
        handoff.clear("session-one");
        expect(slotDescriptor()?.value).toBe(envelope);
      }
      expect(handoff.capture("session-two")).toBeUndefined();
      expect(slotPresent()).toBe(false);
    }
  });

  it("isolates malformed and foreign envelopes without activating their seed", () => {
    for (const envelope of [
      { malformed: true },
      { version: 99, sessionKey: "session-one", seed: completeSeed() },
      { version: 2, sessionKey: "different-session", seed: { revision: -1, overrides: {} } },
    ]) {
      writeSlot({ value: envelope });
      expect(handoff.capture("session-one")).toBeUndefined();
      expect(slotPresent()).toBe(false);
    }
  });
  it("publishes a complete isolated baseline for only the matching Pi session", () => {
    const seed = {
      revision: 4,
      overrides: { reviewer: { candidates: [candidate("openai/override")] } },
      baseline: completeBaseline("global", "openai/baseline"),
    };
    handoff.publish("session-one", seed);

    expect(handoff.capture("session-two")).toBeUndefined();
    expect(handoff.capture("session-one")).toEqual(seed);
    expect(handoff.capture("session-one")).not.toBe(seed);
  });

  it.each([true, false])(
    "restores the previous runtime's profile settings while retiring ultracode=%s",
    (ultracode) => {
      const seed = {
        revision: 7,
        overrides: { worker: { candidates: [candidate("openai/override")] } },
        nesting: { maxDirectChildren: 3, maxDepth: 1 },
        baseline: completeBaseline("project", "openai/baseline"),
      };
      writeSlot({
        value: {
          version: 2,
          sessionKey: "session-one",
          seed: { ...seed, features: { ultracode } },
        },
      });

      const restored = handoff.capture("session-one");
      expect(restored).toEqual(seed);
      expect(handoff.capture("session-one")).toEqual(seed);
      expect(restored).not.toHaveProperty("features");
      handoff.publish("session-one", restored!);
      expect(slotDescriptor()?.value).toEqual({ version: 2, sessionKey: "session-one", seed });
    },
  );

  it("refuses unknown or malformed legacy features and unrelated seed fields", () => {
    for (const legacy of [
      { features: { other: true } },
      { features: { ultracode: true, other: false } },
      { features: { ultracode: "true" } },
      { features: { ultracode: false }, other: true },
    ]) {
      const envelope = {
        version: 2,
        sessionKey: "session-one",
        seed: { ...completeSeed(), ...legacy },
      };
      writeSlot({ value: envelope });
      expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
      expect(slotDescriptor()?.value).toBe(envelope);
      handoff.clear();
    }
  });

  it("rejects an envelope without its complete baseline", () => {
    writeSlot({
      value: { version: 2, sessionKey: "session-one", seed: { revision: 2, overrides: {} } },
    });
    expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
    expect(slotPresent()).toBe(true);
  });

  it.each([
    {
      label: "non-finite revision",
      seed: { revision: Number.NaN, overrides: {}, baseline: completeBaseline("global") },
    },
    {
      label: "malformed candidate",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [{ host: "local" }] } },
        baseline: completeBaseline("global"),
      },
    },
    {
      label: "unknown profile",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [] }, unknown: { candidates: [] } },
        baseline: completeBaseline("global"),
      },
    },
  ])("keeps an undecodable matching $label handoff fail-closed", ({ seed }) => {
    writeSlot({ value: { version: 2, sessionKey: "session-one", seed } });
    expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
    expect(slotPresent()).toBe(true);
  });

  it("rejects candidate accessors in captured and published seeds without invoking them", () => {
    let candidateReads = 0;
    const accessorCandidate = { ...candidate("openai/getter") };
    Object.defineProperty(accessorCandidate, "model", {
      enumerable: true,
      get() {
        candidateReads += 1;
        return "openai/getter";
      },
    });
    const accessorSeed = {
      revision: 1,
      overrides: { reviewer: { candidates: [accessorCandidate] } },
      baseline: completeBaseline("global"),
    };
    writeSlot({ value: { version: 2, sessionKey: "session-one", seed: accessorSeed } });

    expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
    expect(candidateReads).toBe(0);
    expect(slotPresent()).toBe(true);
    handoff.clear();

    expect(() => handoff.publish("session-one", accessorSeed)).not.toThrow();
    expect(candidateReads).toBe(0);
    expect(slotPresent()).toBe(false);
  });

  it("rejects oversized baseline arrays before reading any candidate element", () => {
    const baseline = completeBaseline("global");
    let candidateElementReads = 0;
    const candidates = new Proxy(
      Array.from({ length: 33 }, () => null),
      {
        get(target, key) {
          if (key === "length") return target.length;
          candidateElementReads += 1;
          throw new Error("candidate element should not be read");
        },
      },
    );
    writeSlot({
      value: {
        version: 2,
        sessionKey: "session-one",
        seed: {
          revision: 1,
          overrides: {},
          baseline: { ...baseline, profiles: { ...baseline.profiles, reviewer: { candidates } } },
        },
      },
    });

    expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
    expect(candidateElementReads).toBe(0);
    expect(slotPresent()).toBe(true);
  });

  it("contains hostile process-slot accessors and deletion failures", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const installThrowingAccessor = () =>
      Object.defineProperty(globalThis, reloadSlot, {
        configurable: true,
        get() {
          getterCalls += 1;
          throw new Error("reload getter must not run");
        },
        set() {
          setterCalls += 1;
          throw new Error("reload setter must not run");
        },
      });

    installThrowingAccessor();
    expect(() => handoff.capture("session-one")).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(slotPresent()).toBe(false);

    installThrowingAccessor();
    expect(() => handoff.publish("session-one", completeSeed())).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(setterCalls).toBe(0);
    expect(handoff.capture("session-one")).toBeDefined();

    writeSlot({ value: { malformed: true } });
    const deleteSpy = vi.spyOn(Reflect, "deleteProperty").mockImplementation(() => {
      throw new Error("hostile deletion");
    });
    try {
      expect(() => handoff.capture("session-one")).not.toThrow();
      expect(() => handoff.clear()).not.toThrow();
      expect(deleteSpy).toHaveBeenCalled();
    } finally {
      deleteSpy.mockRestore();
      Reflect.deleteProperty(globalThis, reloadSlot);
    }
  });

  it("clears conditionally without deleting a different session handoff", () => {
    handoff.publish("session-one", completeSeed());
    handoff.clear("session-two");
    expect(handoff.capture("session-one")).toBeDefined();
    handoff.clear("session-one");
    expect(handoff.capture("session-one")).toBeUndefined();
  });

  it("enforces bounded session keys at both host capture and publication", () => {
    const maximumKey = "s".repeat(1_024);
    const overlongKey = "s".repeat(1_025);

    expect(
      profileReloadSessionKey(
        extensionContextFixture({ sessionManager: { getSessionId: () => maximumKey } }),
      ),
    ).toBe(maximumKey);
    for (const sessionId of ["", overlongKey]) {
      expect(
        profileReloadSessionKey(
          extensionContextFixture({ sessionManager: { getSessionId: () => sessionId } }),
        ),
      ).toBeUndefined();
    }
    expect(
      profileReloadSessionKey(
        extensionContextFixture({
          sessionManager: {
            getSessionId: () => {
              throw new Error("The session identity is unavailable.");
            },
          },
        }),
      ),
    ).toBeUndefined();

    handoff.publish("", completeSeed());
    handoff.publish(overlongKey, completeSeed());
    expect(slotPresent()).toBe(false);
    handoff.publish(maximumKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeDefined();
    handoff.publish(overlongKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeUndefined();
  });
});
