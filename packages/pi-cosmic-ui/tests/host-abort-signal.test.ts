import { describe, expect, it } from "vitest";
import { snapshotHostAbortSignal } from "../src/boundary/host-abort-signal.ts";
import { capturedSignal } from "./support/host.ts";

describe("host callback abort ownership", () => {
  it("forwards an abort that happens after capture and releases exactly once", () => {
    const controller = new AbortController();
    const source = capturedSignal(controller.signal);
    const snapshot = snapshotHostAbortSignal(() => source.signal);
    expect(snapshot?.aborted).toBe(false);
    expect(source.addEventListener).toHaveBeenCalledOnce();

    controller.abort();
    expect(snapshot?.signal?.aborted).toBe(true);
    snapshot?.release();
    snapshot?.release();
    expect(source.removeEventListener).toHaveBeenCalledOnce();
  });

  it("attempts release when a hostile source registers and then throws", () => {
    const source = capturedSignal(undefined, undefined, true);
    expect(snapshotHostAbortSignal(() => source.signal)).toBeUndefined();
    expect(source.removeEventListener).toHaveBeenCalledOnce();
    expect(source.removeEventListener.mock.calls[0]?.[1]).toBe(
      source.addEventListener.mock.calls[0]?.[1],
    );
  });
});
