// Test harness boundary: Promise-shaped driver fixtures intentionally live here.
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off

/** A plain Promise deferred for Promise-shaped test driver boundaries. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause?: Error) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, reject, resolve };
}

/** Waits one macrotask so detached handler work can settle. */
export async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
