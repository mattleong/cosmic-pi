import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { WorkingMessageHost } from "../boundary/host-working-message.ts";

const UPDATE_INTERVAL_MS = 1_000;

interface WorkingTimerState {
  readonly generation: number;
  readonly startedAt: number;
  readonly active: boolean;
}

export function formatWorkingElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes === 0) return `${seconds}s`;
  const minutes = totalMinutes % 60;
  if (totalMinutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
}

export const formatWorkingMessage = (milliseconds: number): string =>
  `Working · ${formatWorkingElapsed(milliseconds)}`;

export interface WorkingTimerServiceShape {
  readonly start: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/** Owns the elapsed-time ticker for Pi's live working row. */
export class WorkingTimerService extends Context.Service<
  WorkingTimerService,
  WorkingTimerServiceShape
>()("pi-cosmic-ui/working/service/WorkingTimerService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const host = yield* WorkingMessageHost;
      const scope = yield* Effect.scope;
      const state = yield* SynchronizedRef.make<WorkingTimerState>({
        generation: 0,
        startedAt: 0,
        active: false,
      });

      const tick = (generation: number): Effect.Effect<boolean> =>
        SynchronizedRef.modifyEffect(state, (current) => {
          if (!current.active || current.generation !== generation)
            return Effect.succeed([false, current] as const);
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) => host.set(formatWorkingMessage(now - current.startedAt))),
            Effect.map((available) => [available, { ...current, active: available }] as const),
          );
        });

      const ticker = (generation: number): Effect.Effect<void> =>
        Effect.sleep(UPDATE_INTERVAL_MS).pipe(
          Effect.andThen(tick(generation)),
          Effect.flatMap((active) => (active ? ticker(generation) : Effect.void)),
        );

      const start = SynchronizedRef.modifyEffect(state, (current) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((startedAt) =>
            host
              .set(formatWorkingMessage(0))
              .pipe(Effect.map((available) => ({ available, startedAt }))),
          ),
          Effect.map(({ available, startedAt }) => {
            const next = {
              generation: current.generation + 1,
              startedAt,
              active: available,
            } as const;
            return [next.generation, next] as const;
          }),
        ),
      ).pipe(
        Effect.flatMap((generation) => Effect.forkIn(ticker(generation), scope)),
        Effect.asVoid,
      );

      const stop = SynchronizedRef.modifyEffect(state, (current) =>
        host
          .set()
          .pipe(
            Effect.as([
              undefined,
              { ...current, generation: current.generation + 1, active: false },
            ] as const),
          ),
      );

      yield* Effect.addFinalizer(() => stop);
      return WorkingTimerService.of({ start, stop });
    }),
  );
}
