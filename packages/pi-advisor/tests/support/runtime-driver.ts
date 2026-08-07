// Test harness boundary: the controllable driver is Promise-shaped by contract.
// @effect-diagnostics effect/asyncFunction:off
import { vi } from "vitest";
import type {
  AdvisorCheckpoint,
  AdvisorCheckpointRequest,
  AdvisorRuntimeDriver,
} from "../../src/runtime/runtime.ts";
import { deferred } from "./async.ts";

export interface ControllableRuntimeOptions {
  activeToolNames?: string[] | undefined;
  startError?: Error | undefined;
  startPromise?: Promise<void> | undefined;
  disposePromise?: Promise<void> | undefined;
}

export interface ControllableRuntime {
  driver: AdvisorRuntimeDriver;
  requests: AdvisorCheckpointRequest[];
  pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>>;
}

/**
 * A controllable AdvisorRuntimeDriver: every checkpoint records its request
 * and stays pending until the test settles its deferred.
 */
export function controllableRuntimeDriver(
  options: ControllableRuntimeOptions = {},
): ControllableRuntime {
  const requests: AdvisorCheckpointRequest[] = [];
  const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
  const driver: AdvisorRuntimeDriver = {
    activeToolNames: options.activeToolNames ?? ["read", "grep", "find", "ls"],
    start: vi.fn(async () => {
      if (options.startError) throw options.startError;
      await options.startPromise;
    }),
    checkpoint: vi.fn((request: AdvisorCheckpointRequest) => {
      requests.push(request);
      const wait = deferred<AdvisorCheckpoint>();
      pending.push(wait);
      return wait.promise;
    }),
    steer: vi.fn(async () => true),
    reprime: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(async () => {
      await options.disposePromise;
    }),
  };
  return { driver, pending, requests };
}
