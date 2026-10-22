import { inspect } from "node:util";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import type { BoundedProcessResult } from "pi-cosmic-core";
import {
  createSharpAdmission,
  makeSharpAdapter as makeOwnedSharpAdapter,
  type SharpProcessRunner,
} from "../src/boundary/sharp.ts";

const makeSharpAdapter = (run: SharpProcessRunner, admission = createSharpAdmission()) =>
  makeOwnedSharpAdapter(
    (bytes, onCleanup) =>
      run(bytes, onCleanup).pipe(Effect.ensuring(Effect.sync(() => onCleanup(true)))),
    admission,
  );

const bytes = new Uint8Array([1, 2, 3]);
const success: BoundedProcessResult = {
  code: 0,
  signal: null,
  stdout: '{"format":"png"}',
  stderr: "",
  overflowed: false,
  timedOut: false,
  cleanupUnconfirmed: false,
};

it.effect("decodes only bounded format metadata from the owned runner", () =>
  Effect.gen(function* () {
    const adapter = makeSharpAdapter((input) => {
      expect(input).toBe(bytes);
      return Effect.succeed(success);
    });
    expect(yield* adapter.decode(bytes)).toEqual({ format: "png" });
  }),
);

for (const patch of [
  { stdout: '{"format":"png","pixels":"secret"}' },
  { code: 1, stderr: "secret native diagnostic" },
]) {
  it.effect(`sanitizes invalid decoder result ${JSON.stringify(patch)}`, () =>
    Effect.gen(function* () {
      const failure = yield* makeSharpAdapter(() => Effect.succeed({ ...success, ...patch }))
        .decode(bytes)
        .pipe(Effect.flip);
      expect(inspect(failure)).not.toContain("secret");
    }),
  );
}

it.effect("queues concurrent decodes on shared admission held through cancelled cleanup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    let running = 0;
    let overlapped = false;
    const admission = createSharpAdmission();
    const runner: SharpProcessRunner = () =>
      Effect.sync(() => {
        running++;
        if (running > 1) overlapped = true;
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(finish)),
        Effect.as(success),
        Effect.ensuring(Effect.sync(() => running--)),
      );
    const first = yield* makeSharpAdapter(runner, admission).decode(bytes).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const second = yield* makeSharpAdapter(runner, admission).decode(bytes).pipe(Effect.forkScoped);
    yield* Deferred.succeed(finish, undefined);
    expect(yield* Fiber.join(first)).toEqual({ format: "png" });
    expect(yield* Fiber.join(second)).toEqual({ format: "png" });
    expect(overlapped).toBe(false);

    const closing = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const blockedStart = yield* Deferred.make<void>();
    let reused = false;
    const cancelled = yield* makeSharpAdapter(
      () =>
        Effect.scoped(
          Effect.acquireRelease(Deferred.succeed(blockedStart, undefined), () =>
            Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      admission,
    )
      .decode(bytes)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(blockedStart);
    const waiting = yield* makeSharpAdapter(() => {
      reused = true;
      return Effect.succeed(success);
    }, admission)
      .decode(bytes)
      .pipe(Effect.forkScoped);
    const interruption = yield* Fiber.interrupt(cancelled).pipe(Effect.forkScoped);
    yield* Deferred.await(closing);
    yield* Effect.yieldNow;
    expect(reused).toBe(false);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interruption);
    expect(yield* Fiber.join(waiting)).toEqual({ format: "png" });
    expect(reused).toBe(true);
  }),
);

it.effect("lets a waiting decode be interrupted without running", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const admission = createSharpAdmission();
    let spawned = false;
    const holder = yield* makeSharpAdapter(
      () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      admission,
    )
      .decode(bytes)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const waiting = yield* makeSharpAdapter(() => {
      spawned = true;
      return Effect.succeed(success);
    }, admission)
      .decode(bytes)
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(waiting);
    yield* Fiber.interrupt(holder);
    expect(spawned).toBe(false);
  }),
);

it.effect("disables all subsequent adapters after unconfirmed cleanup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const admission = createSharpAdmission();
    const failed = makeOwnedSharpAdapter(
      (_bytes, onCleanup) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => onCleanup(false))),
        ),
      admission,
    );
    const pending = yield* failed.decode(bytes).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);
    let spawned = false;
    const next = makeSharpAdapter(() => {
      spawned = true;
      return Effect.succeed(success);
    }, admission);
    expect(yield* next.decode(bytes).pipe(Effect.flip)).toMatchObject({
      operation: "unavailable",
    });
    expect(spawned).toBe(false);
  }),
);
