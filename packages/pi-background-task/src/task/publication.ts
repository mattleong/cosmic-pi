import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Semaphore from "effect/Semaphore";

const OUTPUT_PUBLISH_INTERVAL_MILLIS = 1_000;

export const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) =>
  Number(nanos / 1_000_000n),
);

export const startTaskPublication = (lock: Semaphore.Semaphore, emit: () => void) =>
  Effect.gen(function* () {
    const withLock = Semaphore.withPermit(lock);
    let outputPending = false;
    let outputDeadline = 0;
    const outputWake = yield* Latch.make();
    const publish = () => {
      outputPending = false;
      emit();
    };
    yield* Effect.gen(function* () {
      yield* Latch.await(outputWake);
      const delayMillis = yield* withLock(
        Effect.map(monotonicMillis, (now) => Math.max(0, outputDeadline - now)),
      );
      yield* Effect.sleep(Duration.millis(delayMillis));
      yield* withLock(
        Effect.gen(function* () {
          yield* Latch.close(outputWake);
          if (!outputPending) return;
          outputDeadline = (yield* monotonicMillis) + OUTPUT_PUBLISH_INTERVAL_MILLIS;
          publish();
        }),
      );
    }).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }));
    const publishOutput = Effect.gen(function* () {
      outputPending = true;
      const now = yield* monotonicMillis;
      if (now >= outputDeadline) {
        outputDeadline = now + OUTPUT_PUBLISH_INTERVAL_MILLIS;
        publish();
      } else {
        yield* Latch.open(outputWake);
      }
    });
    return { publish, publishOutput };
  });
