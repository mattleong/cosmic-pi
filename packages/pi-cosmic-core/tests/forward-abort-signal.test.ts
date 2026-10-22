import { describe, expect, it, vi } from "vitest";
import { forwardAbortSignal } from "../src/runtime/runtime.ts";

describe("host abort-signal forwarding", () => {
  it("forwards a later abort and releases its listener exactly once", () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const forwarded = forwardAbortSignal(controller.signal);
    expect(forwarded.signal.aborted).toBe(false);

    controller.abort();
    expect(forwarded.signal.aborted).toBe(true);
    forwarded.release();
    forwarded.release();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("observes an abort that already happened and leaves no listener behind", () => {
    const controller = new AbortController();
    controller.abort();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const forwarded = forwardAbortSignal(controller.signal);
    expect(forwarded.signal.aborted).toBe(true);
    expect(removeEventListener).toHaveBeenCalledOnce();
    forwarded.release();
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("treats a host signal that throws while registering as aborted", () => {
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    vi.spyOn(controller.signal, "addEventListener").mockImplementation(() => {
      throw new Error("stale host signal");
    });
    const forwarded = forwardAbortSignal(controller.signal);
    expect(forwarded.signal.aborted).toBe(true);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });
});
