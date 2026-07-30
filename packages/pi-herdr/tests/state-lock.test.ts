// Test-owned filesystem setup exercises the cross-process state-lock boundary.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterEach, describe, expect, it } from "vitest";
import { withHerdrStateLock } from "../src/boundary/state-lock.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-herdr-state-lock-"));
  roots.push(root);
  return join(root, "state");
};

describe("pi-herdr state lock", () => {
  it("serializes independent users of the same filesystem key", async () => {
    const key = await fixture();
    const events: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const first = yield* withHerdrStateLock(
            key,
            Effect.sync(() => events.push("first-entered")).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(Effect.sync(() => events.push("first-released"))),
            ),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const second = yield* withHerdrStateLock(
            key,
            Effect.sync(() => events.push("second-entered")),
          ).pipe(Effect.forkScoped);
          yield* Effect.sleep("25 millis");
          expect(events).toEqual(["first-entered"]);
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      ),
    );
    expect(events).toEqual(["first-entered", "first-released", "second-entered"]);
  });

  it("allows a waiter to be interrupted while another process owns the lock", async () => {
    const key = await fixture();
    const events: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const attempted = yield* Deferred.make<void>();
          const first = yield* withHerdrStateLock(
            key,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(releaseFirst))),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const waiter = yield* Deferred.succeed(attempted, undefined).pipe(
            Effect.andThen(
              withHerdrStateLock(
                key,
                Effect.sync(() => events.push("waiter-entered")),
              ),
            ),
            Effect.forkScoped,
          );
          yield* Deferred.await(attempted);
          yield* Effect.sleep("25 millis");
          yield* Fiber.interrupt(waiter);
          expect(events).toEqual([]);
          yield* Deferred.succeed(releaseFirst, undefined);
          yield* Fiber.join(first);
        }),
      ),
    );
  });

  it("releases ownership when the protected effect fails", async () => {
    const key = await fixture();
    await Effect.runPromise(withHerdrStateLock(key, Effect.fail("expected")).pipe(Effect.exit));
    await expect(
      Effect.runPromise(withHerdrStateLock(key, Effect.succeed("reacquired"))),
    ).resolves.toBe("reacquired");
  });

  it("reclaims an ownership directory left by a dead process", async () => {
    const key = await fixture();
    const lockPath = `${key}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner"), "orphan\n2147483647\n");

    const result = await Effect.runPromise(withHerdrStateLock(key, Effect.succeed("acquired")));

    expect(result).toBe("acquired");
  });
});
