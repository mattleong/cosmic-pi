import { afterEach, describe, expect, it } from "vitest";
import {
  IncompatibleProfileReloadHandoffError,
  profileReloadHandoff as handoff,
} from "../src/application/profile-reload-handoff.ts";
import { completeBaseline, profileCandidate as candidate } from "./fixtures/profiles.ts";
import * as Rec from "effect/Record";

const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");

afterEach(() => handoff.clear());

const slotPresent = () => Rec.has<string | symbol, unknown>(globalThis, reloadSlot);
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
      const invalid = { ...candidate("openai/invalid"), host: "local" };
      const seed =
        location === "override"
          ? { ...completeSeed(7), overrides: { worker: { candidates: [invalid] } } }
          : {
              ...completeSeed(7),
              baseline: {
                ...baseline,
                profiles: { ...baseline.profiles, worker: { candidates: [invalid] } },
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

  it("clears conditionally without deleting a different session handoff", () => {
    handoff.publish("session-one", completeSeed());
    handoff.clear("session-two");
    expect(handoff.capture("session-one")).toBeDefined();
    handoff.clear("session-one");
    expect(handoff.capture("session-one")).toBeUndefined();
  });
});
