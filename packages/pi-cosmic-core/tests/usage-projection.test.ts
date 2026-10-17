import { describe, expect, it } from "vitest";
import * as MutableRef from "effect/MutableRef";
import {
  initialUsageProjection,
  makeFrozenUsageProjection,
  resetFrozenUsageProjection,
  synchronizeUsageProjectionContext,
  type UsageProjectionBase,
} from "../src/usage-projection.ts";

interface TestSnapshot {
  readonly label: string;
}

interface TestProjection extends UsageProjectionBase<never, TestSnapshot> {
  readonly teamId: string | undefined;
  readonly accountId: string | undefined;
}

const initialProjection = (): TestProjection => ({
  ...initialUsageProjection<never, TestSnapshot>(),
  teamId: undefined,
  accountId: undefined,
});

const makeProjectionRef = () => makeFrozenUsageProjection(initialProjection);

const hidden = { hiddenStatusText: "Usage hidden: not a subscription model." };

describe("usage projection helpers", () => {
  it("builds and resets the frozen initial projection with provider extras", () => {
    const ref = makeProjectionRef();
    const initial = initialProjection();
    expect(MutableRef.get(ref)).toEqual(initial);
    expect(Object.isFrozen(MutableRef.get(ref))).toBe(true);

    synchronizeUsageProjectionContext(ref, () => ({
      eligible: false,
      clearUsage: true,
      statusTexts: hidden,
    }));
    expect(MutableRef.get(ref).statusText).toBe(hidden.hiddenStatusText);

    resetFrozenUsageProjection(ref, initialProjection);
    expect(MutableRef.get(ref)).toEqual(initial);
    expect(Object.isFrozen(MutableRef.get(ref))).toBe(true);
  });

  it("applies a decision to the exact projection state observed by its callback", () => {
    const ref = makeProjectionRef();
    const observed = MutableRef.get(ref);

    synchronizeUsageProjectionContext(ref, (state) => {
      expect(state).toBe(observed);
      MutableRef.set(ref, { ...state, accountId: "reentrant-update", statusText: "Reentrant." });
      return { eligible: true, clearUsage: true, statusTexts: hidden };
    });

    const published = MutableRef.get(ref);
    expect(published.accountId).toBeUndefined();
    expect(Object.isFrozen(published)).toBe(true);
  });
});
