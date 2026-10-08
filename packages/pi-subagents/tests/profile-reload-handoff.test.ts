import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IncompatibleProfileReloadHandoffError,
  profileReloadHandoff as handoff,
  profileReloadSessionKey,
} from "../src/application/profile-reload-handoff.ts";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";

const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");
interface TestReloadGlobalState {
  [reloadSlot]?: object;
}

// SAFETY: The test owns and clears this process-local symbol slot.
const processState = globalThis as typeof globalThis & TestReloadGlobalState;

afterEach(() => handoff.clear());

const slotPresent = () => Object.prototype.hasOwnProperty.call(processState, reloadSlot);
/** Leaves `seed` in the process slot, as an earlier module instance's shutdown would. */
const install = <Seed>(seed: Seed, version = 2) => {
  processState[reloadSlot] = { version, sessionKey: "session-one", seed };
};
const completeSeed = (revision = 0) => ({
  revision,
  overrides: {},
  baseline: completeBaseline("global"),
});

describe("profile reload handoff", () => {
  it.each([1, 2])(
    "preserves incompatible version-%i same-session handoffs across module replacements",
    (version) => {
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
        const envelope = { version, sessionKey: "session-one", seed };
        processState[reloadSlot] = envelope;
        for (let replacement = 0; replacement < 3; replacement += 1) {
          expect(() => handoff.capture("session-one")).toThrow(
            IncompatibleProfileReloadHandoffError,
          );
          expect(processState[reloadSlot]).toBe(envelope);
          handoff.clear("session-one");
          expect(processState[reloadSlot]).toBe(envelope);
        }
        expect(handoff.capture("session-two")).toBeUndefined();
        expect(slotPresent()).toBe(false);
      }
    },
  );

  it("isolates malformed and foreign envelopes without activating their seed", () => {
    for (const envelope of [
      { malformed: true },
      { version: 99, sessionKey: "session-one", seed: completeSeed() },
      { version: 2, sessionKey: "different-session", seed: { revision: -1, overrides: {} } },
    ]) {
      processState[reloadSlot] = envelope;
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

  it("still decodes the version-1 envelope and old seed shape", () => {
    install({ revision: 2, overrides: {} }, 1);
    expect(handoff.capture("session-one")).toEqual({ revision: 2, overrides: {} });
  });

  it("rejects a version-2 envelope without its complete baseline", () => {
    install({ revision: 2, overrides: {} });
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
    install(seed);
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
    install(accessorSeed);

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
    install({
      revision: 1,
      overrides: {},
      baseline: { ...baseline, profiles: { ...baseline.profiles, reviewer: { candidates } } },
    });

    expect(() => handoff.capture("session-one")).toThrow(IncompatibleProfileReloadHandoffError);
    expect(candidateElementReads).toBe(0);
    expect(slotPresent()).toBe(true);
  });

  it("contains hostile process-slot accessors and deletion failures", () => {
    let getterCalls = 0;
    let setterCalls = 0;
    const installThrowingAccessor = () =>
      Object.defineProperty(processState, reloadSlot, {
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

    processState[reloadSlot] = { malformed: true };
    const deleteSpy = vi.spyOn(Reflect, "deleteProperty").mockImplementation(() => {
      throw new Error("hostile deletion");
    });
    try {
      expect(() => handoff.capture("session-one")).not.toThrow();
      expect(() => handoff.clear()).not.toThrow();
      expect(deleteSpy).toHaveBeenCalled();
    } finally {
      deleteSpy.mockRestore();
      Reflect.deleteProperty(processState, reloadSlot);
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
    let hostileLengthReads = 0;
    const hostileSessionId = Object.defineProperty({}, "length", {
      get() {
        hostileLengthReads += 1;
        throw new Error("length must not be read");
      },
    });

    expect(
      profileReloadSessionKey(
        extensionContextFixture({ sessionManager: { getSessionId: () => maximumKey } }),
      ),
    ).toBe(maximumKey);
    for (const sessionId of ["", overlongKey, hostileSessionId]) {
      // SAFETY: This test deliberately supplies hostile runtime values through Pi's string contract.
      expect(
        profileReloadSessionKey(
          extensionContextFixture({
            sessionManager: { getSessionId: () => sessionId as never },
          }),
        ),
      ).toBeUndefined();
    }
    expect(hostileLengthReads).toBe(0);
    expect(
      profileReloadSessionKey(extensionContextFixture({ sessionManager: {} })),
    ).toBeUndefined();

    // SAFETY: This test deliberately supplies a hostile runtime value through the string contract.
    expect(() => handoff.publish(hostileSessionId as never, completeSeed())).not.toThrow();
    handoff.publish("", completeSeed());
    handoff.publish(overlongKey, completeSeed());
    expect(slotPresent()).toBe(false);
    handoff.publish(maximumKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeDefined();
    handoff.publish(overlongKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeUndefined();
  });
});
