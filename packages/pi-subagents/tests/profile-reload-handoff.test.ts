import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeProfileReloadHandoff,
  profileReloadSessionKey,
} from "../src/application/profile-reload-handoff.ts";

const handoff = makeProfileReloadHandoff();
const reloadSlot = Symbol.for("@cosmic-pi/pi-subagents/profile-reload-handoff/v1");
const processState = globalThis as unknown as Record<PropertyKey, unknown>;

afterEach(() => handoff.clear());

describe("profile reload handoff", () => {
  it("publishes an isolated clone for only the matching Pi session", () => {
    const seed = {
      revision: 4,
      overrides: {
        reviewer: {
          candidates: [
            {
              host: "local" as const,
              runtime: "pi" as const,
              model: "openai/reviewer",
              effort: "high" as const,
              context: "fresh" as const,
              writeIntent: "read-only" as const,
              fastMode: false,
              closeOnReport: true,
            },
          ],
        },
      },
    };
    handoff.publish("session-one", seed);

    expect(handoff.capture("session-two")).toBeUndefined();
    expect(handoff.capture("session-one")).toEqual(seed);
    expect(handoff.capture("session-one")).not.toBe(seed);
  });

  it.each([
    {
      label: "non-finite revision",
      seed: { revision: Number.NaN, overrides: {} },
    },
    {
      label: "malformed candidate",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [{ host: "local" }] } },
      },
    },
    {
      label: "unknown profile",
      seed: {
        revision: 1,
        overrides: { reviewer: { candidates: [] }, unknown: { candidates: [] } },
      },
    },
  ])("rejects and removes a malformed $label reload envelope", ({ seed }) => {
    processState[reloadSlot] = {
      version: 1,
      sessionKey: "session-one",
      seed,
    };
    expect(handoff.capture("session-one")).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(processState, reloadSlot)).toBe(false);
  });

  it("clears conditionally without deleting a different session handoff", () => {
    handoff.publish("session-one", { revision: 0, overrides: {} });
    handoff.clear("session-two");
    expect(handoff.capture("session-one")).toBeDefined();
    handoff.clear("session-one");
    expect(handoff.capture("session-one")).toBeUndefined();
  });

  it("derives the stable reload key from Pi session identity", () => {
    const ctx = {
      sessionManager: { getSessionId: () => "session-42" },
    } as unknown as ExtensionContext;
    expect(profileReloadSessionKey(ctx)).toBe("session-42");
    expect(
      profileReloadSessionKey({ sessionManager: {} } as unknown as ExtensionContext),
    ).toBeUndefined();
  });
});
