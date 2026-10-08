import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { invokeBestEffort } from "../host-session.ts";
import type { PiApi } from "./pi-api.ts";
import type { PiManagedRuntime } from "./runtime.ts";

declare const PiSessionRuntimeSlotRuntimeError: unique symbol;

export class PiSessionRuntimeError extends Schema.TaggedError<PiSessionRuntimeError>()(
  "PiSessionRuntimeError",
  { operation: Schema.String, message: Schema.String },
) {}

interface PiSessionRuntimeHooks<Input, R, StartupError, RuntimeError, StartupValue = void> {
  readonly makeRuntime: (input: Input) => PiManagedRuntime<R, RuntimeError>;
  readonly startup: (input: Input) => Effect.Effect<StartupValue, StartupError, PiApi | R>;
  readonly onActivated?: (input: Input, token: number, value: StartupValue) => void;
  readonly onDeactivated?: (input: Input, token: number) => void;
  readonly onStartFailure?: (input: Input, token: number) => void;
}

export interface PiSessionRuntimeSlot<Input, R, RuntimeError = unknown> {
  readonly [PiSessionRuntimeSlotRuntimeError]?: Types.Covariant<RuntimeError>;
  readonly start: (input: Input, signal?: AbortSignal) => Promise<number | undefined>;
  readonly run: <A, E>(effect: Effect.Effect<A, E, PiApi | R>, signal?: AbortSignal) => Promise<A>;
  readonly fork: <A, E>(
    effect: Effect.Effect<A, E, PiApi | R>,
    signal?: AbortSignal,
  ) => Fiber.Fiber<A, E | RuntimeError> | undefined;
  readonly shutdown: () => Promise<void>;
  readonly isActive: () => boolean;
  readonly isCurrent: (token: number) => boolean;
}

type Active<Input, R, RuntimeError> = {
  readonly input: Input;
  readonly token: number;
  readonly runtime: PiManagedRuntime<R, RuntimeError>;
  readonly removeAbort: () => void;
  activated: boolean;
  /** Memoized so each runtime is disposed exactly once. */
  disposal?: Promise<void>;
};

/**
 * The minimal imperative island that owns the runtime which cannot own its own creation.
 * All resources acquired after `start` are scoped by the managed runtime.
 */
export function makePiSessionRuntimeSlot<
  Input,
  R,
  StartupError = unknown,
  RuntimeError = unknown,
  StartupValue = void,
>(
  hooks: PiSessionRuntimeHooks<Input, R, StartupError, RuntimeError, StartupValue>,
): PiSessionRuntimeSlot<Input, R, RuntimeError> {
  let generation = 0;
  let active: Active<Input, R, RuntimeError> | undefined;
  let transition: Promise<unknown> = Promise.resolve();

  const dispose = (runtime: PiManagedRuntime<R, RuntimeError>): Promise<void> =>
    Promise.resolve()
      .then(() => runtime.dispose())
      .catch(() => undefined);

  const removeActive = (expected?: Active<Input, R, RuntimeError>): Promise<void> => {
    const current = active;
    if (!current || (expected && current !== expected)) return Promise.resolve();
    active = undefined;
    invokeBestEffort(current.removeAbort);
    invokeBestEffort(() => hooks.onDeactivated?.(current.input, current.token));
    current.disposal ??= dispose(current.runtime);
    return current.disposal;
  };

  const serialize = <A>(operation: () => Promise<A>): Promise<A> => {
    const result = transition.then(operation, operation);
    transition = result.catch(() => undefined);
    return result;
  };

  const notifyStartFailure = (input: Input, token: number): void => {
    if (token !== generation) return;
    invokeBestEffort(() => hooks.onStartFailure?.(input, token));
  };

  const failStart = (current: Active<Input, R, RuntimeError>): Promise<undefined> =>
    removeActive(current).then(() => {
      notifyStartFailure(current.input, current.token);
      return undefined;
    });

  const start = (input: Input, signal?: AbortSignal): Promise<number | undefined> => {
    const token = ++generation;
    const previousDisposal = removeActive();
    return serialize(() =>
      previousDisposal.then(() => {
        if (token !== generation) return undefined;
        let runtime: PiManagedRuntime<R, RuntimeError>;
        try {
          runtime = hooks.makeRuntime(input);
        } catch {
          notifyStartFailure(input, token);
          return undefined;
        }
        let current: Active<Input, R, RuntimeError>;
        const abort = () => {
          if (active !== current || token !== generation) return;
          ++generation;
          const removal = removeActive(current);
          void serialize(() => removal);
        };
        const removeAbort = () => signal?.removeEventListener("abort", abort);
        current = { input, token, runtime, removeAbort, activated: false };
        active = current;
        try {
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) {
            abort();
            current.disposal ??= dispose(runtime);
            return current.disposal.then(() => undefined);
          }
        } catch {
          return failStart(current);
        }
        let started: Promise<StartupValue>;
        try {
          started = runtime.run(
            hooks.startup(input).pipe(Effect.withSpan("pi-cosmic-core.runtime.startup")),
            signal,
          );
        } catch {
          return failStart(current);
        }
        return Promise.resolve(started).then(
          (value) => {
            if (active !== current || token !== generation) return undefined;
            current.activated = true;
            invokeBestEffort(() => hooks.onActivated?.(input, token, value));
            return active === current && token === generation ? token : undefined;
          },
          () => failStart(current),
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
    const removal = removeActive();
    return serialize(() => removal);
  };

  return {
    start,
    run,
    fork,
    shutdown,
    isActive: () => active?.activated === true,
    isCurrent: (token) => token === generation && active?.activated === true,
  };
}
