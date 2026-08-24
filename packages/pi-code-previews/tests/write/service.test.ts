// Scoped cache lifecycle assertions.
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { provideBuiltLayer } from "pi-cosmic-core";
import { lookupBeforeWrite } from "../../src/write/projection";
import { CodePreviewWriteService } from "../../src/write/service";

it.effect("bounds correlation entries and replaces reused call identifiers atomically", () =>
  CodePreviewWriteService.use((service) =>
    Effect.gen(function* () {
      for (let index = 0; index < 65; index++)
        yield* service.rememberBeforeWrite(`tool-${index}`, {
          kind: "content",
          content: String(index),
        });
      assert.equal(lookupBeforeWrite("tool-0"), undefined);
      assert.deepEqual(lookupBeforeWrite("tool-1"), {
        kind: "content",
        content: "1",
      });
      yield* service.rememberBeforeWrite("tool-64", {
        kind: "content",
        content: "replacement",
      });
      assert.deepEqual(lookupBeforeWrite("tool-64"), {
        kind: "content",
        content: "replacement",
      });
      assert.equal(Object.isFrozen(lookupBeforeWrite("tool-64")), true);
    }),
  ).pipe(provideBuiltLayer(CodePreviewWriteService.layer)),
);

it.effect("serializes the same path while allowing different paths to proceed", () =>
  CodePreviewWriteService.use((service) =>
    Effect.gen(function* () {
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const samePathEntered = yield* Deferred.make<void>();
      const otherPathEntered = yield* Deferred.make<void>();
      const first = yield* service
        .withPathLock(
          "/workspace/file.ts",
          Deferred.succeed(firstEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(firstEntered);
      const samePath = yield* service
        .withPathLock(
          "/workspace/file.ts",
          Deferred.succeed(samePathEntered, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkScoped);
      const otherPath = yield* service
        .withPathLock(
          "/workspace/other.ts",
          Deferred.succeed(otherPathEntered, undefined).pipe(Effect.asVoid),
        )
        .pipe(Effect.forkScoped);

      yield* Deferred.await(otherPathEntered);
      assert.equal(Deferred.isDoneUnsafe(samePathEntered), false);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(samePath);
      yield* Fiber.join(otherPath);
      assert.equal(Deferred.isDoneUnsafe(samePathEntered), true);
    }),
  ).pipe(Effect.scoped, provideBuiltLayer(CodePreviewWriteService.layer)),
);

it.effect("releases an interrupted path waiter without poisoning the next acquisition", () =>
  CodePreviewWriteService.use((service) =>
    Effect.gen(function* () {
      const holderEntered = yield* Deferred.make<void>();
      const releaseHolder = yield* Deferred.make<void>();
      const holder = yield* service
        .withPathLock(
          "/workspace/file.ts",
          Deferred.succeed(holderEntered, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHolder)),
          ),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(holderEntered);
      const interrupted = yield* service
        .withPathLock("/workspace/file.ts", Effect.void)
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(releaseHolder, undefined);
      yield* Fiber.join(holder);

      let acquired = false;
      yield* service.withPathLock(
        "/workspace/file.ts",
        Effect.sync(() => {
          acquired = true;
        }),
      );
      assert.equal(acquired, true);
    }),
  ).pipe(Effect.scoped, provideBuiltLayer(CodePreviewWriteService.layer)),
);

it.effect("preserves the caller scope for resources acquired inside a path lock", () => {
  let released = false;
  return Effect.gen(function* () {
    yield* Effect.scoped(
      CodePreviewWriteService.use((service) =>
        Effect.gen(function* () {
          yield* service.withPathLock(
            "/workspace/file.ts",
            Effect.acquireRelease(Effect.void, () =>
              Effect.sync(() => {
                released = true;
              }),
            ),
          );
          assert.equal(released, false);
        }),
      ).pipe(provideBuiltLayer(CodePreviewWriteService.layer)),
    );
    assert.equal(released, true);
  });
});

it.effect("before-write snapshots are cleared when the owning session scope closes", () =>
  Effect.gen(function* () {
    yield* Effect.scoped(
      CodePreviewWriteService.use((service) =>
        Effect.gen(function* () {
          yield* service.rememberBeforeWrite("tool", { kind: "content", content: "secret" });
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
          assert.deepEqual(lookupBeforeWrite("tool"), {
            kind: "content",
            content: "secret",
          });
        }),
      ).pipe(provideBuiltLayer(CodePreviewWriteService.layer)),
    );
    assert.equal(lookupBeforeWrite("tool"), undefined);
  }),
);
