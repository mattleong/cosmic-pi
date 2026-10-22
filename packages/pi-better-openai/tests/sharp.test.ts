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

it.effect(
  "shares immediate admission between adapters and retains it through cancelled cleanup",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reused = false;
      const admission = createSharpAdmission();
      const first = makeSharpAdapter(
        () =>
          Effect.scoped(
            Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
              Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ).pipe(Effect.andThen(Effect.never)),
          ),
        admission,
      );
      const second = makeSharpAdapter(() => {
        reused = true;
        return Effect.succeed(success);
      }, admission);
      const fiber = yield* first.decode(bytes).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      expect((yield* second.decode(bytes).pipe(Effect.result))._tag).toBe("Failure");
      const interruption = yield* Fiber.interrupt(fiber).pipe(Effect.forkScoped);
      yield* Deferred.await(closing);
      expect((yield* second.decode(bytes).pipe(Effect.result))._tag).toBe("Failure");
      expect(reused).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interruption);
      expect(yield* second.decode(bytes)).toEqual({ format: "png" });
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
    expect((yield* next.decode(bytes).pipe(Effect.result))._tag).toBe("Failure");
    expect(spawned).toBe(false);
  }),
);
