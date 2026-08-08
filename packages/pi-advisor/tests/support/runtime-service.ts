// Test harness boundary: controllable child stubs stay Promise-shaped behind Effect layers.
// @effect-diagnostics effect/asyncFunction:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi, type Mock } from "vitest";
import { AdvisorModelError } from "../../src/runtime/client.ts";
import {
  AdvisorRuntimeService,
  type AdvisorCheckpoint,
  type AdvisorCheckpointRequest,
  type AdvisorRuntimeServiceShape,
  type AdvisorRuntimeStartOptions,
} from "../../src/runtime/runtime.ts";
import { deferred } from "./async.ts";

export interface ControllableRuntimeOptions {
  activeToolNames?: string[] | undefined;
  startError?: Error | undefined;
  startPromises?: Array<Promise<void> | undefined> | undefined;
  disposePromises?: Array<Promise<void> | undefined> | undefined;
}

/** One logical advisor child: created per `start`, controlled through its deferreds. */
export interface ControllableRuntimeInstance {
  readonly driver: {
    readonly start: Mock;
    readonly checkpoint: Mock;
    readonly steer: Mock;
    readonly reprime: Mock;
    readonly abort: Mock;
    readonly dispose: Mock;
  };
  readonly requests: AdvisorCheckpointRequest[];
  readonly pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>>;
}

export interface ControllableRuntimeHarness {
  /** One entry per runtime start; assertions target the instance a start created. */
  readonly runtimes: ControllableRuntimeInstance[];
  /** Checkpoint requests and deferreds aggregated across every instance, in order. */
  readonly requests: AdvisorCheckpointRequest[];
  readonly pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>>;
  readonly layer: Layer.Layer<AdvisorRuntimeService>;
}

const toModelError = (error: unknown): AdvisorModelError =>
  error instanceof AdvisorModelError
    ? error
    : new AdvisorModelError({
        message: error instanceof Error ? error.message : "Advisor test runtime failed.",
      });

/**
 * A controllable Effect-shaped AdvisorRuntimeService layer: every `start` opens a new
 * logical child instance and every checkpoint stays pending until the test settles it.
 */
export function controllableRuntimeService(
  options: ControllableRuntimeOptions = {},
): ControllableRuntimeHarness {
  const runtimes: ControllableRuntimeInstance[] = [];
  const requests: AdvisorCheckpointRequest[] = [];
  const pending: Array<ReturnType<typeof deferred<AdvisorCheckpoint>>> = [];
  let current: ControllableRuntimeInstance | undefined;
  const newInstance = (): ControllableRuntimeInstance => {
    const index = runtimes.length;
    const instance: ControllableRuntimeInstance = {
      driver: {
        start: vi.fn(async (_options: AdvisorRuntimeStartOptions) => {
          if (options.startError) throw options.startError;
          await options.startPromises?.[index];
        }),
        checkpoint: vi.fn((request: AdvisorCheckpointRequest) => {
          instance.requests.push(request);
          requests.push(request);
          const wait = deferred<AdvisorCheckpoint>();
          instance.pending.push(wait);
          pending.push(wait);
          return wait.promise;
        }),
        steer: vi.fn(async () => true),
        reprime: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        dispose: vi.fn(async () => {
          await options.disposePromises?.[index];
        }),
      },
      requests: [],
      pending: [],
    };
    runtimes.push(instance);
    return instance;
  };
  const withCurrent = <A>(
    operation: (instance: ControllableRuntimeInstance) => Promise<A>,
    fallback: A,
  ): Effect.Effect<A, AdvisorModelError> =>
    Effect.suspend(() => {
      const instance = current;
      if (!instance) return Effect.succeed(fallback);
      return Effect.tryPromise({ try: () => operation(instance), catch: toModelError });
    });
  const service: AdvisorRuntimeServiceShape = {
    activeToolNames: () => options.activeToolNames ?? ["read", "grep", "find", "ls"],
    start: (startOptions) =>
      Effect.suspend(() => {
        const instance = newInstance();
        current = instance;
        return Effect.tryPromise({
          try: () => instance.driver.start(startOptions) as Promise<void>,
          catch: toModelError,
        });
      }),
    checkpoint: (request) =>
      withCurrent(
        (instance) => instance.driver.checkpoint(request) as Promise<AdvisorCheckpoint>,
        undefined as never,
      ),
    steer: (observations) =>
      withCurrent((instance) => instance.driver.steer(observations) as Promise<boolean>, false),
    reprime: (seed, stateSummary) =>
      withCurrent(
        (instance) => instance.driver.reprime(seed, stateSummary) as Promise<void>,
        undefined,
      ),
    abort: () =>
      withCurrent((instance) => instance.driver.abort() as Promise<void>, undefined).pipe(
        Effect.catch(() => Effect.void),
      ),
    dispose: () =>
      withCurrent((instance) => instance.driver.dispose() as Promise<void>, undefined).pipe(
        Effect.catch(() => Effect.void),
      ),
  };
  return {
    runtimes,
    requests,
    pending,
    layer: Layer.succeed(AdvisorRuntimeService, AdvisorRuntimeService.of(service)),
  };
}
