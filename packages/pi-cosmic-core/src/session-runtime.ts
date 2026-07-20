import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { PiApi } from "./pi-api.ts";
import type { PiManagedRuntime } from "./runtime.ts";

export class PiSessionRuntimeError extends Schema.TaggedErrorClass<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface PiSessionRuntimeHooks<Input, R, StartupError, RuntimeError> {
  readonly makeRuntime: (input: Input) => PiManagedRuntime<R, RuntimeError>;
  readonly startup?: (input: Input) => Effect.Effect<void, StartupError, PiApi | R>;
  readonly onActivated?: (input: Input, token: number) => void;
  readonly onDeactivated?: (input: Input, token: number) => void;
  readonly onStartFailure?: (input: Input, token: number) => void;
}

export interface PiSessionRuntimeSlot<Input, R, RuntimeError = never> {
  readonly start: (input: Input, signal?: AbortSignal) => Promise<number | undefined>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, PiApi | R>, signal?: AbortSignal) => Promise<A>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, PiApi | R>,
    signal?: AbortSignal,
  ) => Fiber.Fiber<A, E | RuntimeError> | undefined;
  readonly shutdown: () => Promise<void>;
  readonly isCurrent: (token: number) => boolean;
}

type Active<Input, R, RuntimeError> = {
  readonly input: Input;
  readonly token: number;
  readonly runtime: PiManagedRuntime<R, RuntimeError>;
  readonly removeAbort: () => void;
};

/**
 * The minimal imperative island that owns the runtime which cannot own its own creation.
 * All resources acquired after `start` are scoped by the managed runtime.
 */
export function makePiSessionRuntimeSlot<Input, R, StartupError = never, RuntimeError = never>(
  hooks: PiSessionRuntimeHooks<Input, R, StartupError, RuntimeError>,
): PiSessionRuntimeSlot<Input, R, RuntimeError> {
  let generation = 0;
  let active: Active<Input, R, RuntimeError> | undefined;
  let transition: Promise<unknown> = Promise.resolve();
  const disposals = new WeakMap<PiManagedRuntime<R, RuntimeError>, Promise<void>>();

  const dispose = (runtime: PiManagedRuntime<R, RuntimeError> | undefined): Promise<void> => {
    if (!runtime) return Promise.resolve();
    const existing = disposals.get(runtime);
    if (existing) return existing;
    const next = runtime.dispose().catch(() => undefined);
    disposals.set(runtime, next);
    return next;
  };

  const removeActive = (expected?: Active<Input, R, RuntimeError>): Promise<void> => {
    const current = active;
    if (!current || (expected && current !== expected)) return Promise.resolve();
    active = undefined;
    try {
      current.removeAbort();
    } catch {
      // Host AbortSignal implementations cannot prevent runtime cleanup.
    }
    try {
      hooks.onDeactivated?.(current.input, current.token);
    } catch {
      // Package cleanup hooks are best effort at the host boundary.
    }
    return dispose(current.runtime);
  };

  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = transition.then(operation, operation);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const start = (input: Input, signal?: AbortSignal): Promise<number | undefined> => {
    const token = ++generation;
    const previous = active;
    const previousDisposal = removeActive(previous);
    return serialize(() =>
      previousDisposal.then(() => {
        if (token !== generation) return undefined;
        const runtime = hooks.makeRuntime(input);
        let current: Active<Input, R, RuntimeError>;
        const abort = () => {
          if (active !== current || token !== generation) return;
          ++generation;
          void removeActive(current);
        };
        const removeAbort = () => signal?.removeEventListener("abort", abort);
        current = { input, token, runtime, removeAbort };
        active = current;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) {
          abort();
          return dispose(runtime).then(() => undefined);
        }
        const startup = hooks.startup?.(input);
        const started = startup
          ? runtime.run(startup.pipe(Effect.withSpan("pi-cosmic-core.runtime.startup")), signal)
          : Promise.resolve();
        return started.then(
          () => {
            if (active !== current || token !== generation) return undefined;
            try {
              hooks.onActivated?.(input, token);
            } catch {
              // Activation hooks cannot take ownership away from the slot.
            }
            return token;
          },
          () =>
            removeActive(current).then(() => {
              if (token === generation) {
                try {
                  hooks.onStartFailure?.(input, token);
                } catch {
                  // Failure notification is best effort.
                }
              }
              return undefined;
            }),
        );
      }),
    );
  };

  const run: PiSessionRuntimeSlot<Input, R, RuntimeError>["run"] = (effect, signal) => {
    const current = active;
    return current
      ? current.runtime.run(effect, signal)
      : Promise.reject(
          new PiSessionRuntimeError({
            operation: "run",
            message: "Pi session runtime is not active.",
          }),
        );
  };

  const fork: PiSessionRuntimeSlot<Input, R, RuntimeError>["fork"] = (effect, signal) =>
    active?.runtime.fork(effect, signal);

  const shutdown = (): Promise<void> => {
    ++generation;
    const current = active;
    const immediate = removeActive(current);
    return serialize(() => immediate);
  };

  return { start, run, fork, shutdown, isCurrent: (token) => token === generation && !!active };
}
