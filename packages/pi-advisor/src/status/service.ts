import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import { interruptFiber } from "../boundary/clock.ts";
import type { AdvisorEffectExecutor } from "../boundary/executor.ts";

export interface AdvisorStatusStartOptions {
  readonly owner: string;
  readonly delayMs: number;
  readonly intervalMs: number;
  readonly animated: boolean;
  readonly frameCount: number;
  readonly render: (frame: number) => void;
}

export const advisorStatusFramesEffect = (
  options: Pick<AdvisorStatusStartOptions, "delayMs" | "intervalMs" | "animated" | "frameCount">,
  render: (frame: number) => void,
): Effect.Effect<void> =>
  Effect.suspend(() => {
    let frame = 1;
    const renderFrame = (nextFrame: number): Effect.Effect<void> =>
      Effect.sync(() => {
        try {
          render(nextFrame);
        } catch {
          // Status rendering is diagnostic-only and remains fail-open.
        }
      });
    const animation = Effect.suspend(() => {
      const nextFrame = frame % Math.max(1, options.frameCount);
      frame += 1;
      return renderFrame(nextFrame);
    }).pipe(Effect.repeat(Schedule.fixed(Duration.millis(options.intervalMs))), Effect.asVoid);
    return Effect.sleep(Duration.millis(options.delayMs)).pipe(
      Effect.andThen(renderFrame(0)),
      Effect.andThen(
        options.animated
          ? Effect.sleep(Duration.millis(options.intervalMs)).pipe(Effect.andThen(animation))
          : Effect.void,
      ),
      Effect.asVoid,
    );
  });

export interface AdvisorStatusServiceContract {
  /** Synchronous Pi admission; timer execution remains Effect-owned. */
  readonly start: (options: AdvisorStatusStartOptions) => void;
  /** Cancels only the matching owner and reports whether the owner matched. */
  readonly settle: (owner: string) => boolean;
  readonly clear: () => void;
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Owns the status delay/animation fiber. Generation checks make replacement and settlement
 * synchronous at the Pi callback boundary even though interruption is performed by Effect.
 */
export const makeAdvisorStatusService = (
  executor: AdvisorEffectExecutor,
): Effect.Effect<AdvisorStatusServiceContract, never, Scope.Scope> =>
  Effect.gen(function* () {
    let generation = 0;
    let owner: string | undefined;
    let fiber: Fiber.Fiber<void> | undefined;

    const interruptCurrent = (): void => {
      const current = fiber;
      fiber = undefined;
      interruptFiber(current);
    };
    const clear = (): void => {
      generation += 1;
      owner = undefined;
      interruptCurrent();
    };
    const start = (options: AdvisorStatusStartOptions): void => {
      clear();
      const currentGeneration = generation;
      owner = options.owner;
      fiber = executor.fork(
        advisorStatusFramesEffect(options, (frame) => {
          if (generation === currentGeneration && owner === options.owner) options.render(frame);
        }),
      );
    };
    const settle = (expectedOwner: string): boolean => {
      if (owner !== expectedOwner) return false;
      clear();
      return true;
    };
    const shutdown = Effect.sync(clear);
    yield* Effect.addFinalizer(() => shutdown);
    return { start, settle, clear, shutdown };
  });
