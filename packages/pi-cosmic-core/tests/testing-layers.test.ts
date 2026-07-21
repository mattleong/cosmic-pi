import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type JsonObject } from "../index.ts";
import { makeInMemoryDocuments } from "../testing.ts";

const setNestedValue = (document: JsonObject, value: number): void => {
  (document.nested as { value: number }).value = value;
};

it.effect("isolates nested values at every in-memory document boundary", () => {
  const initial: JsonObject = { nested: { value: 1 } };
  const memory = makeInMemoryDocuments({ "/config.json": initial });
  setNestedValue(initial, 99);

  return Effect.gen(function* () {
    expect(memory.documents.get("/config.json")).toEqual({ nested: { value: 1 } });
    const inspection = memory.documents.get("/config.json");
    expect(inspection).toBeDefined();
    setNestedValue(inspection!, 100);
    expect(memory.documents.get("/config.json")).toEqual({ nested: { value: 1 } });

    const firstRead = yield* memory.service.readObject("/config.json");
    expect(firstRead).toBeDefined();
    setNestedValue(firstRead!, 2);
    expect(yield* memory.service.readObject("/config.json")).toEqual({ nested: { value: 1 } });

    const written: JsonObject = { nested: { value: 3 } };
    yield* memory.service.writeObject("/config.json", written);
    setNestedValue(written, 30);
    expect(yield* memory.service.readObject("/config.json")).toEqual({ nested: { value: 3 } });

    const returned = yield* memory.service.modifyObject("/config.json", (document) => {
      setNestedValue(document, 4);
      return Effect.succeed({ value: document, document });
    });
    setNestedValue(returned, 40);
    expect(yield* memory.service.readObject("/config.json")).toEqual({ nested: { value: 4 } });
  });
});

it.effect("retains the mutable document-map compatibility handle without leaking aliases", () => {
  const memory = makeInMemoryDocuments();
  const external: JsonObject = { nested: { value: 1 } };
  memory.documents.set("/external.json", external);
  setNestedValue(external, 99);

  return Effect.gen(function* () {
    expect(yield* memory.service.readObject("/external.json")).toEqual({ nested: { value: 1 } });
    expect(memory.documents.delete("/external.json")).toBe(true);
    expect(yield* memory.service.exists("/external.json")).toBe(false);
  });
});

it.effect("serializes gated concurrent modifications on the same path", () =>
  Effect.gen(function* () {
    const firstEntered = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const memory = makeInMemoryDocuments({ "/counter.json": { count: 0 } });
    const increment = (gate: boolean) =>
      memory.service.modifyObject("/counter.json", (document) =>
        Effect.gen(function* () {
          const count = typeof document.count === "number" ? document.count : 0;
          if (gate) {
            yield* Deferred.succeed(firstEntered, undefined);
            yield* Deferred.await(releaseFirst);
          }
          const next: JsonObject = { ...document, count: count + 1 };
          return { value: next.count, document: next };
        }),
      );

    const first = yield* increment(true).pipe(Effect.forkScoped);
    yield* Deferred.await(firstEntered);
    const second = yield* increment(false).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    expect(memory.documents.get("/counter.json")).toEqual({ count: 2 });
  }).pipe(Effect.scoped),
);

it.effect("serializes direct writes with an in-flight modification", () =>
  Effect.gen(function* () {
    const modifyEntered = yield* Deferred.make<void>();
    const releaseModify = yield* Deferred.make<void>();
    const memory = makeInMemoryDocuments({ "/counter.json": { count: 0 } });
    let writeCompleted = false;
    const modifier = yield* memory.service
      .modifyObject("/counter.json", (document) =>
        Deferred.succeed(modifyEntered, undefined).pipe(
          Effect.andThen(Deferred.await(releaseModify)),
          Effect.as({ value: undefined, document: { ...document, count: 1 } }),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(modifyEntered);
    const writer = yield* memory.service
      .writeObject("/counter.json", { count: 100 })
      .pipe(Effect.ensuring(Effect.sync(() => (writeCompleted = true))), Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(writeCompleted).toBe(false);
    yield* Deferred.succeed(releaseModify, undefined);
    yield* Fiber.join(modifier);
    yield* Fiber.join(writer);
    expect(memory.documents.get("/counter.json")).toEqual({ count: 100 });
  }).pipe(Effect.scoped),
);

it.effect("commits an in-memory document and hook atomically before honoring interruption", () =>
  Effect.gen(function* () {
    const hookStarted = yield* Deferred.make<void>();
    const releaseHook = yield* Deferred.make<void>();
    const memory = makeInMemoryDocuments({ "/config.json": { enabled: false } });
    let afterCommits = 0;

    const modifier = yield* memory.service
      .modifyObject("/config.json", () =>
        Effect.succeed({
          value: undefined,
          document: { enabled: true },
          afterCommit: Deferred.succeed(hookStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseHook)),
            Effect.andThen(Effect.sync(() => void afterCommits++)),
          ),
        }),
      )
      .pipe(Effect.forkScoped);

    yield* Deferred.await(hookStarted);
    expect(memory.documents.get("/config.json")).toEqual({ enabled: true });
    expect(afterCommits).toBe(0);

    const interruption = yield* Fiber.interrupt(modifier).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseHook, undefined);
    yield* Fiber.join(interruption);

    expect(memory.documents.get("/config.json")).toEqual({ enabled: true });
    expect(afterCommits).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("maps in-memory updater throws to a redacted typed failure without committing", () => {
  const memory = makeInMemoryDocuments({ "/config.json": { enabled: true } });
  return Effect.gen(function* () {
    const result = yield* Effect.result(
      memory.service.updateObject("/config.json", () => {
        throw new Error("secret updater failure");
      }),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure._tag).toBe("JsonDocumentError");
      expect(result.failure.operation).toBe("update");
      expect(result.failure.message).not.toContain("secret updater failure");
    }
    expect(yield* memory.service.readObject("/config.json")).toEqual({ enabled: true });
  });
});
