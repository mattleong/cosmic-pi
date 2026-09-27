import { describe, expect, it } from "vitest";
import * as MutableRef from "effect/MutableRef";
import {
  initialUsageProjection,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
} from "../src/usage-projection.ts";

interface TestSnapshot {
  readonly label: string;
}

interface TestExtras {
  readonly teamId: string | undefined;
  readonly accountId: string | undefined;
}

const initialExtras = (): TestExtras => ({ teamId: undefined, accountId: undefined });

const makeProjectionRef = () =>
  makeFrozenUsageProjection<never, TestSnapshot, TestExtras>(initialExtras());

describe("usage projection helpers", () => {
  it("makeFrozenUsageProjection freezes the base fields and provider extras", () => {
    const ref = makeProjectionRef();
    const state = MutableRef.get(ref);
    expect(state.teamId).toBeUndefined();
    expect(state.eligible).toBe(false);
    expect(state.statusText).toBe("Usage unavailable");
    expect(Object.isFrozen(state)).toBe(true);

    // Freezing must survive a transition published through the shared helpers.
    synchronizeUsageProjectionContext(ref, () => ({
      eligible: true,
      clearUsage: false,
      statusTexts: { hiddenStatusText: "Hidden." },
    }));
    const next = MutableRef.get(ref);
    expect(next.eligible).toBe(true);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("resetFrozenUsageProjection rebuilds the frozen initial projection with fresh extras", () => {
    const ref = makeProjectionRef();
    synchronizeUsageProjectionContext(ref, (state) =>
      state.config === undefined
        ? { eligible: false, clearUsage: true, statusTexts: { hiddenStatusText: "Hidden." } }
        : { eligible: true, clearUsage: false },
    );
    expect(MutableRef.get(ref).statusText).toBe("Hidden.");

    resetFrozenUsageProjection(ref, initialExtras);
    const reset = MutableRef.get(ref);
    expect(reset).toEqual({
      ...initialUsageProjection<never, TestSnapshot>(),
      teamId: undefined,
      accountId: undefined,
    });
    expect(Object.isFrozen(reset)).toBe(true);
  });

  it("applies a decision to the exact projection state observed by its callback", () => {
    const ref = makeProjectionRef();
    const observed = MutableRef.get(ref);

    synchronizeUsageProjectionContext(ref, (state) => {
      expect(state).toBe(observed);
      MutableRef.set(ref, { ...state, accountId: "reentrant-update", statusText: "Reentrant." });
      return {
        eligible: true,
        clearUsage: true,
        statusTexts: { hiddenStatusText: "Hidden." },
      };
    });

    const published = MutableRef.get(ref);
    expect(published.accountId).toBeUndefined();
    expect(published.statusText).toBe("Usage unavailable");
    expect(Object.isFrozen(published)).toBe(true);
  });

  it("synchronizeUsageProjectionContext applies eligibility decisions and default texts", () => {
    const ref = makeProjectionRef();

    // Eligible without overrides: unavailable status text falls back to the shared default
    // on a clearing transition.
    synchronizeUsageProjectionContext(ref, () => ({ eligible: true, clearUsage: true }));
    expect(MutableRef.get(ref).statusText).toBe("Usage unavailable");
    expect(MutableRef.get(ref).snapshot).toBeUndefined();

    // Hidden with explicit texts: both overrides are honored.
    synchronizeUsageProjectionContext(ref, () => ({
      eligible: false,
      clearUsage: false,
      statusTexts: {
        hiddenStatusText: "Usage hidden: not a subscription model.",
        unavailableStatusText: "Custom unavailable.",
      },
    }));
    expect(MutableRef.get(ref).statusText).toBe("Usage hidden: not a subscription model.");

    // Omitted hidden text falls back to the generic message instead of a type error path.
    synchronizeUsageProjectionContext(ref, () => ({ eligible: false, clearUsage: false }));
    expect(MutableRef.get(ref).statusText).toBe("Usage hidden");

    // An eligible no-clear decision leaves visible fields and status untouched, and the
    // decision callback observes the pre-synchronization state.
    synchronizeUsageProjectionContext(ref, (state) => ({
      eligible: state.statusLine === undefined,
      clearUsage: false,
    }));
    expect(MutableRef.get(ref).statusText).toBe("Usage hidden");
  });
});
