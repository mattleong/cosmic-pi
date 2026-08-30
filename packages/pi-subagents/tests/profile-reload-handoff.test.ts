import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeProfileReloadHandoff,
  profileReloadSessionKey,
} from "../src/application/profile-reload-handoff.ts";
import { extensionContextFixture } from "./fixtures/pi-host.ts";

const handoff = makeProfileReloadHandoff();
const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");
interface TestReloadGlobalState {
  [reloadSlot]?: object;
}

// SAFETY: The test owns and clears this process-local symbol slot.
const processState = globalThis as typeof globalThis & TestReloadGlobalState;

afterEach(() => handoff.clear());

const candidate = (model: string) => ({
  host: "local" as const,
  runtime: "pi" as const,
  model,
  effort: "high" as const,
  context: "fresh" as const,
  writeIntent: "read-only" as const,
  openaiFastMode: false,
  closeOnReport: true,
});
const completeProfiles = (reviewerModel = "parent") => ({
  scout: { candidates: [candidate("parent")] },
  researcher: { candidates: [candidate("parent")] },
  planner: { candidates: [candidate("parent")] },
  worker: { candidates: [candidate("parent")] },
  reviewer: { candidates: [candidate(reviewerModel)] },
  oracle: { candidates: [candidate("parent")] },
  generalist: { candidates: [candidate("parent")] },
});
const completeSources = {
  scout: "global" as const,
  researcher: "global" as const,
  planner: "global" as const,
  worker: "global" as const,
  reviewer: "global" as const,
  oracle: "global" as const,
  generalist: "global" as const,
};
const completeBaseline = (reviewerModel = "parent") => ({
  origin: { scope: "global" as const, name: "saved" },
  profiles: completeProfiles(reviewerModel),
  profileSources: completeSources,
});
const completeSeed = (revision = 0) => ({
  revision,
  overrides: {},
  baseline: completeBaseline(),
});

describe("profile reload handoff", () => {
  it("publishes a complete isolated baseline for only the matching Pi session", () => {
    const seed = {
      revision: 4,
      overrides: { reviewer: { candidates: [candidate("openai/override")] } },
      baseline: completeBaseline("openai/baseline"),
    };
    handoff.publish("session-one", seed);

    expect(handoff.capture("session-two")).toBeUndefined();
    expect(handoff.capture("session-one")).toEqual(seed);
    expect(handoff.capture("session-one")).not.toBe(seed);
  });

  it("still decodes the version-1 envelope and old seed shape", () => {
    processState[reloadSlot] = {
      version: 1,
      sessionKey: "session-one",
      seed: { revision: 2, overrides: {} },
    };
    expect(handoff.capture("session-one")).toEqual({ revision: 2, overrides: {} });
  });

  it("rejects a version-2 envelope without its complete baseline", () => {
    processState[reloadSlot] = {
      version: 2,
      sessionKey: "session-one",
      seed: { revision: 2, overrides: {} },
    };
    expect(handoff.capture("session-one")).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
  });

  it.each([
    {
      label: "non-finite revision",
      seed: { revision: Number.NaN, overrides: {}, baseline: completeBaseline() },
    },
    {
      label: "malformed candidate",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [{ host: "local" }] } },
        baseline: completeBaseline(),
      },
    },
    {
      label: "unknown profile",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [] }, unknown: { candidates: [] } },
        baseline: completeBaseline(),
      },
    },
  ])("rejects and removes a malformed $label reload envelope", ({ seed }) => {
    processState[reloadSlot] = {
      version: 2,
      sessionKey: "session-one",
      seed,
    };
    expect(handoff.capture("session-one")).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
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
      baseline: completeBaseline(),
    };
    processState[reloadSlot] = {
      version: 2,
      sessionKey: "session-one",
      seed: accessorSeed,
    };

    expect(() => handoff.capture("session-one")).not.toThrow();
    expect(handoff.capture("session-one")).toBeUndefined();
    expect(candidateReads).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);

    expect(() => handoff.publish("session-one", accessorSeed)).not.toThrow();
    expect(candidateReads).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
  });

  it("rejects oversized baseline arrays before reading any candidate element", () => {
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
    processState[reloadSlot] = {
      version: 2,
      sessionKey: "session-one",
      seed: {
        revision: 1,
        overrides: {},
        baseline: {
          origin: { scope: "global", name: "saved" },
          profiles: {
            ...completeProfiles(),
            reviewer: { candidates },
          },
          profileSources: completeSources,
        },
      },
    };

    expect(handoff.capture("session-one")).toBeUndefined();
    expect(candidateElementReads).toBe(0);
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
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
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);

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

    // SAFETY: This test deliberately supplies a hostile runtime value through the string contract.
    expect(() => handoff.publish(hostileSessionId as never, completeSeed())).not.toThrow();
    handoff.publish("", completeSeed());
    handoff.publish(overlongKey, completeSeed());
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
    handoff.publish(maximumKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeDefined();
    handoff.publish(overlongKey, completeSeed());
    expect(handoff.capture(maximumKey)).toBeUndefined();
  });

  it("derives the stable reload key from Pi session identity", () => {
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = extensionContextFixture({
      sessionManager: { getSessionId: () => "session-42" },
    });
    expect(profileReloadSessionKey(ctx)).toBe("session-42");
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    expect(
      profileReloadSessionKey(extensionContextFixture({ sessionManager: {} })),
    ).toBeUndefined();
  });
});
