import { invokeHostCallback } from "pi-cosmic-core";

export interface HostAbortSignalSnapshot {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
  readonly release: () => void;
}

/** Owns a native abort forwarder so capture-to-registration races cannot lose a host abort. */
export function snapshotHostAbortSignal(
  read: () => AbortSignal | undefined,
): HostAbortSignalSnapshot | undefined {
  return invokeHostCallback<HostAbortSignalSnapshot | undefined>(() => {
    const source = read();
    if (!source)
      return Object.freeze({ signal: undefined, aborted: false, release: () => undefined });
    const controller = new AbortController();
    const forward = () => controller.abort();
    let registered = true;
    const release = () => {
      if (!registered) return;
      registered = false;
      invokeHostCallback(() => source.removeEventListener("abort", forward), undefined);
    };
    try {
      source.addEventListener("abort", forward, { once: true });
      if (source.aborted) controller.abort();
    } catch (error) {
      release();
      throw error;
    }
    return Object.freeze({
      signal: controller.signal,
      aborted: controller.signal.aborted,
      release,
    });
  }, undefined);
}
