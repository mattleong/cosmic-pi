import { describe, expect, it } from "vitest";
import * as MutableRef from "effect/MutableRef";
import { withCapturedHostSignal } from "../src/host-invocation.ts";
import { extensionContextFixture, modelFixture } from "../testing.ts";

describe("captured host invocation signal", () => {
  it("retains the exact signal after Pi clears or replaces its live getter", () => {
    const admitted = new AbortController();
    let liveSignal: AbortSignal | undefined = admitted.signal;
    const ctx = extensionContextFixture({
      get signal() {
        return liveSignal;
      },
    });
    const invocation = withCapturedHostSignal(ctx, ctx.signal);
    liveSignal = undefined;
    admitted.abort();
    expect(invocation.signal).toBe(admitted.signal);
    expect(invocation.signal?.aborted).toBe(true);
    liveSignal = new AbortController().signal;
    expect(invocation.signal).toBe(admitted.signal);
    expect(invocation.signal?.aborted).toBe(true);
    expect(ctx.signal?.aborted).toBe(false);
  });

  it("does not adopt a later signal when the admitted command had none", () => {
    const live = MutableRef.make<AbortSignal | undefined>(undefined);
    const ctx = extensionContextFixture({
      get signal() {
        return MutableRef.get(live);
      },
    });
    const invocation = withCapturedHostSignal(ctx, ctx.signal);
    MutableRef.set(live, AbortSignal.abort());
    expect(invocation.signal).toBeUndefined();
  });

  it("keeps model getters lazy and live with their original receiver", () => {
    const first = modelFixture({ id: "first" });
    const second = modelFixture({ id: "second" });
    let model = first;
    let allowRead = false;
    const ctx = extensionContextFixture({
      get model() {
        if (!allowRead) throw new Error("Model read before use");
        expect(this).toBe(ctx);
        return model;
      },
    });
    const invocation = withCapturedHostSignal(ctx, undefined);
    allowRead = true;
    expect(invocation.model).toBe(first);
    model = second;
    expect(invocation.model).toBe(second);
  });

  it("preserves host revocation instead of creating independent context authority", () => {
    const admitted = new AbortController();
    let retired = false;
    const ctx = extensionContextFixture({
      get signal() {
        if (retired) throw new Error("Retired context");
        return admitted.signal;
      },
      get model() {
        if (retired) throw new Error("Retired context");
        return undefined;
      },
    });
    const invocation = withCapturedHostSignal(ctx, ctx.signal);
    retired = true;
    admitted.abort();
    expect(invocation.signal?.aborted).toBe(true);
    expect(() => invocation.model).toThrow("Retired context");
  });
});
