import { captureHostSignal, invokeHostCallback } from "pi-cosmic-core";

export const capturedHostSignal = (
  ctx: Parameters<typeof captureHostSignal>[0],
): AbortSignal | undefined => {
  const captured = captureHostSignal(ctx);
  return captured._tag === "Captured" ? captured.signal : undefined;
};

export interface HostAbortSignalSnapshot {
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
  readonly release: () => void;
}

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
