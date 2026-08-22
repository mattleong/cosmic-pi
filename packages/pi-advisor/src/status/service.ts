import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

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
      // Status rendering is diagnostic-only and remains fail-open.
      Effect.try({
        try: () => render(nextFrame),
        catch: () => undefined,
      }).pipe(Effect.ignore);
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
}

/**
 * Owns the status delay/animation fiber. Generation checks make replacement and settlement
 * synchronous at the Pi callback boundary even though interruption is performed by Effect.
 */
export type AdvisorStatusFrames = (
  options: AdvisorStatusStartOptions,
  render: (frame: number) => void,
) => Effect.Effect<void>;

export const makeAdvisorStatusService = (
  frames: AdvisorStatusFrames = advisorStatusFramesEffect,
): Effect.Effect<AdvisorStatusServiceContract, never, Scope.Scope> =>
  Effect.gen(function* () {
    const animation = yield* FiberHandle.make<void>();
    const runAnimation = yield* FiberHandle.runtime(animation)<never>();
    let generation = 0;
    let owner: string | undefined;

    const resetState = (): void => {
      generation += 1;
      owner = undefined;
    };
    const interruptCurrent = (): void => {
      Option.getOrUndefined(FiberHandle.getUnsafe(animation))?.interruptUnsafe();
    };
    const clear = (): void => {
      resetState();
      interruptCurrent();
    };
    const start = (options: AdvisorStatusStartOptions): void => {
      resetState();
      const currentGeneration = generation;
      owner = options.owner;
      runAnimation(
        frames(options, (frame) => {
          if (generation === currentGeneration) options.render(frame);
        }),
      );
    };
    const settle = (expectedOwner: string): boolean => {
      if (owner !== expectedOwner) return false;
      clear();
      return true;
    };
    return { start, settle, clear };
  });
