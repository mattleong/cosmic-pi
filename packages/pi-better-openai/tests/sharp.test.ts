import { inspect } from "node:util";
import { vi } from "vitest";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { BoundedProcessError, type BoundedProcessResult } from "pi-cosmic-core";
import {
  makeSharpAdapter as makeOwnedSharpAdapter,
  type SharpProcessRunner,
} from "../src/boundary/sharp.ts";

// These fakes acquire no native process and can guarantee their cleanup.
const makeSharpAdapter = (run: SharpProcessRunner) =>
  makeOwnedSharpAdapter((bytes, onCleanup) =>
    run(bytes, onCleanup).pipe(Effect.ensuring(Effect.sync(() => onCleanup(true)))),
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
  dispatched: true,
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
  { stdout: "secret not JSON" },
  { stdout: '{"format":"svg"}' },
  { stdout: '{"format":"png","pixels":"secret"}' },
  { stdout: " ".repeat(129) },
  { code: 1, stderr: "secret native diagnostic" },
  { signal: "SIGKILL" },
  { overflowed: true },
  { timedOut: true },
  { dispatched: false },
]) {
  it.effect(`sanitizes invalid decoder result ${JSON.stringify(patch)}`, () =>
    Effect.gen(function* () {
      const result = yield* makeSharpAdapter(() => Effect.succeed({ ...success, ...patch }))
        .decode(bytes)
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(inspect(result)).not.toContain("secret");
    }),
  );
}

it.effect("rejects oversized and empty input before acquiring process authority", () =>
  Effect.gen(function* () {
    let spawned = false;
    const adapter = makeSharpAdapter(() => {
      spawned = true;
      return Effect.succeed(success);
    });
    for (const input of [new Uint8Array(), new Uint8Array(60 * 1024 * 1024 + 1)])
      expect((yield* adapter.decode(input).pipe(Effect.result))._tag).toBe("Failure");
    expect(spawned).toBe(false);
  }),
);

it.effect("sanitizes runner failures and restores admission", () =>
  Effect.gen(function* () {
    const failed = makeSharpAdapter(() =>
      Effect.fail(new BoundedProcessError({ operation: "spawn", message: "secret path" })),
    );
    const result = yield* failed.decode(bytes).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(inspect(result)).not.toContain("secret");
    expect(yield* makeSharpAdapter(() => Effect.succeed(success)).decode(bytes)).toEqual({
      format: "png",
    });
  }),
);

it.effect(
  "shares immediate admission between adapters and retains it through cancelled cleanup",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const closing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let reused = false;
      const first = makeSharpAdapter(() =>
        Effect.scoped(
          Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
            Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ).pipe(Effect.andThen(Effect.never)),
        ),
      );
      const second = makeSharpAdapter(() => {
        reused = true;
        return Effect.succeed(success);
      });
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

it.live("shares admission across independent Effect runtimes", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = makeSharpAdapter(() =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(success),
      ),
    );
    // Explicit standalone runtime entry proves admission is not fiber/runtime-local.
    const pending = Effect.runPromise(first.decode(bytes));
    yield* Effect.gen(function* () {
      yield* Deferred.await(started);
      const second = makeSharpAdapter(() => Effect.succeed(success));
      expect(yield* second.decode(bytes).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
    }).pipe(
      Effect.ensuring(
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(Effect.tryPromise(() => pending)),
          Effect.orDie,
        ),
      ),
    );
  }),
);

for (const outcome of ["error", "timeout", "missing-report"] as const) {
  it.live(`disables admission after ${outcome} without confirmed cleanup`, () =>
    Effect.gen(function* () {
      // A fresh module models restart without adding a production latch reset API.
      vi.resetModules();
      const { makeSharpAdapter: makeFresh } = yield* Effect.tryPromise(
        () => import("../src/boundary/sharp.ts"),
      );
      const failed = makeFresh((_bytes, onCleanup) => {
        if (outcome === "missing-report") return Effect.succeed(success);
        const result =
          outcome === "error"
            ? Effect.fail(new BoundedProcessError({ operation: "stream", message: "private" }))
            : Effect.succeed({ ...success, timedOut: true, cleanupUnconfirmed: true });
        return result.pipe(Effect.ensuring(Effect.sync(() => onCleanup(false))));
      });
      expect(yield* failed.decode(bytes).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      let spawned = false;
      const next = makeFresh(() => {
        spawned = true;
        return Effect.succeed(success);
      });
      expect(yield* next.decode(bytes).pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      expect(spawned).toBe(false);
    }),
  );
}

// Last: no reset API exists for a production cleanup-uncertain latch.
it.effect("disables all subsequent adapters after unconfirmed cleanup", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const failed = makeOwnedSharpAdapter((_bytes, onCleanup) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => onCleanup(false))),
      ),
    );
    const pending = yield* failed.decode(bytes).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(pending);
    let spawned = false;
    const next = makeSharpAdapter(() => {
      spawned = true;
      return Effect.succeed(success);
    });
    expect((yield* next.decode(bytes).pipe(Effect.result))._tag).toBe("Failure");
    expect(spawned).toBe(false);
  }),
);
