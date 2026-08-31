import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import type {
  WorkingMessageHostContract,
  WorkingMessageHostResult,
} from "../boundary/host-working-message.ts";

const UPDATE_INTERVAL_MS = 1_000;
const WAITING_MESSAGE = "Waiting for user";

interface WorkingTimerState {
  readonly generation: number;
  readonly activeWorkStartedAt: number | undefined;
  readonly elapsedMilliseconds: number;
  readonly outputActiveStartedAt: number | undefined;
  readonly outputMilliseconds: number;
  readonly outputCharacters: number;
  readonly active: boolean;
  readonly waiting: boolean;
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

export function estimateTokensPerSecond(
  outputCharacters: number,
  milliseconds: number,
): number | undefined {
  if (outputCharacters <= 0 || milliseconds < 1_000) return undefined;
  const estimatedTokens = outputCharacters / 4;
  return estimatedTokens / (milliseconds / 1_000);
}

export const formatWorkingMessage = (
  milliseconds: number,
  outputCharacters = 0,
  outputMilliseconds = milliseconds,
): string => {
  const elapsed = formatWorkingElapsed(milliseconds);
  const tokensPerSecond = estimateTokensPerSecond(outputCharacters, outputMilliseconds);
  return tokensPerSecond === undefined
    ? `Working · ${elapsed}`
    : `Working · ${elapsed} · ~${tokensPerSecond.toFixed(1)} tok/s`;
};

export interface WorkingTimerServiceContract {
  readonly start: Effect.Effect<void>;
  readonly noteOutputCharacters: (characters: number) => void;
  readonly pauseOutput: Effect.Effect<void>;
  readonly waitForUser: Effect.Effect<void>;
  readonly resumeFromUser: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

const elapsedAt = (state: WorkingTimerState, now: number): number =>
  state.elapsedMilliseconds +
  (state.activeWorkStartedAt === undefined ? 0 : now - state.activeWorkStartedAt);

const outputElapsedAt = (state: WorkingTimerState, now: number): number =>
  state.outputMilliseconds +
  (state.outputActiveStartedAt === undefined ? 0 : now - state.outputActiveStartedAt);

const workingMessageAt = (state: WorkingTimerState, now: number): string =>
  formatWorkingMessage(elapsedAt(state, now), state.outputCharacters, outputElapsedAt(state, now));

/** Owns the elapsed-time ticker for Pi's live working row. */
export class WorkingTimerService extends Context.Service<
  WorkingTimerService,
  WorkingTimerServiceContract
>()("pi-cosmic-ui/working/service/WorkingTimerService") {
  static layer(host: WorkingMessageHostContract) {
    return Layer.effect(
      this,
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const scope = yield* Effect.scope;
        const state = yield* SynchronizedRef.make<WorkingTimerState>({
          generation: 0,
          activeWorkStartedAt: undefined,
          elapsedMilliseconds: 0,
          outputActiveStartedAt: undefined,
          outputMilliseconds: 0,
          outputCharacters: 0,
          active: false,
          waiting: false,
        });

        let pendingOutputCharacters = 0;
        let pendingOutputFirstAt = 0;
        let promptWaiting = false;

        const setHostMessage = (message?: string): Effect.Effect<WorkingMessageHostResult> =>
          host.set(message).pipe(Effect.catchCause(() => Effect.succeed("failed" as const)));

        const activeAfterWrite = (active: boolean, result: WorkingMessageHostResult): boolean =>
          result === "written" || (result === "failed" && active);

        const drainOutputCharacters = Effect.suspend(() => {
          if (pendingOutputCharacters === 0) return Effect.void;
          const increment = pendingOutputCharacters;
          const firstAt = pendingOutputFirstAt;
          pendingOutputCharacters = 0;
          return SynchronizedRef.update(state, (current) =>
            current.active && !current.waiting
              ? {
                  ...current,
                  outputActiveStartedAt: current.outputActiveStartedAt ?? firstAt,
                  outputCharacters: current.outputCharacters + increment,
                }
              : current,
          );
        });

        const tick = (generation: number): Effect.Effect<boolean> =>
          SynchronizedRef.modifyEffect(state, (current) => {
            if (!current.active || current.generation !== generation)
              return Effect.succeed([false, current] as const);
            if (current.waiting)
              return setHostMessage(WAITING_MESSAGE).pipe(
                Effect.map((result) =>
                  result === "unavailable"
                    ? ([false, { ...current, active: false }] as const)
                    : ([true, current] as const),
                ),
              );
            return Clock.currentTimeMillis.pipe(
              Effect.flatMap((now) =>
                setHostMessage(workingMessageAt(current, now)).pipe(
                  Effect.map((result) =>
                    result === "unavailable"
                      ? ([
                          false,
                          {
                            ...current,
                            activeWorkStartedAt: undefined,
                            elapsedMilliseconds: elapsedAt(current, now),
                            outputActiveStartedAt: undefined,
                            outputMilliseconds: outputElapsedAt(current, now),
                            active: false,
                          },
                        ] as const)
                      : ([true, current] as const),
                  ),
                ),
              ),
            );
          });

        const ticker = (generation: number): Effect.Effect<void> =>
          Effect.sleep(Duration.millis(UPDATE_INTERVAL_MS)).pipe(
            Effect.andThen(drainOutputCharacters),
            Effect.andThen(tick(generation)),
            Effect.flatMap((active) => (active ? ticker(generation) : Effect.void)),
          );

        const start = Effect.sync(() => {
          pendingOutputCharacters = 0;
        }).pipe(
          Effect.andThen(
            SynchronizedRef.modifyEffect(state, (current) =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((startedAt) =>
                  setHostMessage(current.waiting ? WAITING_MESSAGE : formatWorkingMessage(0)).pipe(
                    Effect.map((result) => ({ result, startedAt })),
                  ),
                ),
                Effect.map(({ result, startedAt }) => {
                  const active = result !== "unavailable";
                  const next: WorkingTimerState = {
                    generation: current.generation + 1,
                    activeWorkStartedAt: active && !current.waiting ? startedAt : undefined,
                    elapsedMilliseconds: 0,
                    outputActiveStartedAt: undefined,
                    outputMilliseconds: 0,
                    outputCharacters: 0,
                    active,
                    waiting: current.waiting,
                  };
                  return [active ? next.generation : undefined, next] as const;
                }),
              ),
            ),
          ),
          Effect.flatMap((generation) =>
            generation === undefined ? Effect.void : Effect.forkIn(ticker(generation), scope),
          ),
          Effect.asVoid,
        );

        const noteOutputCharacters = (characters: number): void => {
          const increment = Math.max(0, Math.floor(characters));
          if (increment === 0 || promptWaiting) return;
          if (pendingOutputCharacters === 0) pendingOutputFirstAt = clock.currentTimeMillisUnsafe();
          pendingOutputCharacters += increment;
        };

        const pauseOutput = drainOutputCharacters.pipe(
          Effect.andThen(
            SynchronizedRef.modifyEffect(state, (current) => {
              if (!current.active || current.waiting || current.outputActiveStartedAt === undefined)
                return Effect.succeed([undefined, current] as const);
              const outputActiveStartedAt = current.outputActiveStartedAt;
              return Clock.currentTimeMillis.pipe(
                Effect.map(
                  (now) =>
                    [
                      undefined,
                      {
                        ...current,
                        outputActiveStartedAt: undefined,
                        outputMilliseconds:
                          current.outputMilliseconds + (now - outputActiveStartedAt),
                      },
                    ] as const,
                ),
              );
            }),
          ),
        );

        const waitForUser = Effect.sync(() => {
          promptWaiting = true;
        }).pipe(
          Effect.andThen(drainOutputCharacters),
          Effect.andThen(
            SynchronizedRef.modifyEffect(state, (current) => {
              if (current.waiting) return Effect.succeed([undefined, current] as const);
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  setHostMessage(WAITING_MESSAGE).pipe(Effect.map((result) => ({ result, now }))),
                ),
                Effect.map(
                  ({ result, now }) =>
                    [
                      undefined,
                      {
                        ...current,
                        activeWorkStartedAt: undefined,
                        elapsedMilliseconds: current.active
                          ? elapsedAt(current, now)
                          : current.elapsedMilliseconds,
                        outputActiveStartedAt: undefined,
                        outputMilliseconds: current.active
                          ? outputElapsedAt(current, now)
                          : current.outputMilliseconds,
                        active: activeAfterWrite(current.active, result),
                        waiting: true,
                      },
                    ] as const,
                ),
              );
            }),
          ),
        );

        const resumeFromUser = SynchronizedRef.modifyEffect(state, (current) => {
          if (!current.waiting) return Effect.succeed([undefined, current] as const);
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              setHostMessage(workingMessageAt(current, now)).pipe(
                Effect.map((result) => ({ result, now })),
              ),
            ),
            Effect.map(({ result, now }) => {
              const active = activeAfterWrite(current.active, result);
              return [
                undefined,
                {
                  ...current,
                  activeWorkStartedAt: active ? now : undefined,
                  active,
                  waiting: false,
                },
              ] as const;
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              promptWaiting = false;
            }),
          ),
        );

        const stop = Effect.sync(() => {
          pendingOutputCharacters = 0;
          promptWaiting = false;
        }).pipe(
          Effect.andThen(
            SynchronizedRef.modifyEffect(state, (current) =>
              setHostMessage().pipe(
                Effect.as([
                  undefined,
                  {
                    ...current,
                    generation: current.generation + 1,
                    activeWorkStartedAt: undefined,
                    outputActiveStartedAt: undefined,
                    active: false,
                    waiting: false,
                  },
                ] as const),
              ),
            ),
          ),
        );

        yield* Effect.addFinalizer(() => stop);
        return WorkingTimerService.of({
          start,
          noteOutputCharacters,
          pauseOutput,
          waitForUser,
          resumeFromUser,
          stop,
        });
      }),
    );
  }
}
