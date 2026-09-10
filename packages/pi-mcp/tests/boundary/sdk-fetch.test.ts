import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import {
  makeSdkFetch as makeOwnedSdkFetch,
  type SdkFetchOptions,
  SdkFetchBodyError,
  SdkFetchRedirectError,
  SdkFetchResponseLimitError,
} from "../../src/boundary/sdk-fetch.ts";
import { makeSdkHttpControl } from "../../src/boundary/sdk-http-control.ts";
import { SdkHttpOperationRegistry, SdkHttpTraffic } from "../../src/boundary/sdk-http-transport.ts";

const native = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: () => new SdkFetchBodyError(),
  });
// Rejection is test data, not an untyped Effect failure.
const settled = <A>(run: () => Promise<A>) =>
  Effect.promise(() => Promise.resolve().then(run).then(Result.succeed, Result.fail));
const url = "http://example.test/mcp";

const ownership = () => {
  const registry = new SdkHttpOperationRegistry(1);
  const operation = registry.begin();
  if (operation === undefined) throw new Error("Test operation admission failed.");
  operation.bindRequestId(7);
  return { registry, operation, session: registry.traffic };
};

const request = { method: "POST", body: '{"jsonrpc":"2.0","method":"tools/call","id":7}' };

// Lease-only tests drive cancellation directly. Scoped deadline tests below use
// the real control owner instead of this synchronous admission seam.
const makeSdkFetch = (options: Omit<SdkFetchOptions, "beginControl">) =>
  makeOwnedSdkFetch({
    ...options,
    beginControl: () => {
      const owner = new SdkHttpTraffic();
      owner.fetchStarted();
      return owner;
    },
  });

describe("bounded SDK fetch", () => {
  it.effect("strips private headers and owns a completed body", () =>
    Effect.gen(function* () {
      const { registry, operation, session } = ownership();
      let observed: RequestInit | undefined;
      const bounded = makeSdkFetch({
        maxBytes: 128,
        session,
        lookupOperation: registry.lookupRequestId,
        fetch: (_url, init) => {
          observed = init;
          return Promise.resolve(new Response("hello"));
        },
      });
      const response = yield* native(() =>
        bounded(url, {
          ...request,
          headers: { "X-PI-MCP-OPERATION": "private", Authorization: "Bearer fixed" },
        }),
      );
      expect(yield* native(() => response.text())).toBe("hello");
      expect(new Headers(observed?.headers).has("x-pi-mcp-operation")).toBe(false);
      expect(new Headers(observed?.headers).get("authorization")).toBe("Bearer fixed");
      expect(observed?.redirect).toBe("error");
      expect(operation.isIdle).toBe(true);
      expect(session.isIdle).toBe(true);
    }),
  );

  it.effect("never publishes idle between fetch and body ownership", () =>
    Effect.gen(function* () {
      const { registry, session } = ownership();
      const headers = yield* Deferred.make<Response>();
      const fetchSeen = yield* Deferred.make<void>();
      const idleSeen = yield* Deferred.make<void>();
      const bounded = makeSdkFetch({
        maxBytes: 128,
        session,
        lookupOperation: registry.lookupRequestId,
        fetch: () => {
          Deferred.doneUnsafe(fetchSeen, Effect.void);
          return Effect.runPromise(Deferred.await(headers));
        },
      });
      const pending = yield* Effect.forkChild(native(() => bounded(url, request)));
      yield* Deferred.await(fetchSeen);
      const idle = yield* Effect.forkChild(
        session.awaitIdle().pipe(Effect.andThen(Deferred.succeed(idleSeen, undefined))),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(headers, new Response(new ReadableStream<Uint8Array>()));
      const response = yield* Fiber.join(pending);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(idleSeen)).toBe(false);
      yield* native(() => response.body!.cancel());
      yield* Fiber.join(idle);
      expect(session.isIdle).toBe(true);
    }),
  );

  for (const kind of ["redirect", "declared-limit"] as const) {
    it.effect(`retains ${kind} discard ownership until source cleanup settles`, () =>
      Effect.gen(function* () {
        const { registry, session, operation } = ownership();
        const release = yield* Deferred.make<void>();
        let cancelled = false;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
              return Effect.runPromise(Deferred.await(release));
            },
          }),
          { headers: kind === "declared-limit" ? { "content-length": "1000" } : {} },
        );
        if (kind === "redirect") Object.defineProperty(response, "redirected", { value: true });
        const bounded = makeSdkFetch({
          maxBytes: 128,
          session,
          lookupOperation: registry.lookupRequestId,
          fetch: () => Promise.resolve(response),
        });
        const result = yield* settled(() => bounded(url, request));
        expect(Result.isFailure(result) && result.failure).toBeInstanceOf(
          kind === "redirect" ? SdkFetchRedirectError : SdkFetchResponseLimitError,
        );
        expect(cancelled).toBe(true);
        expect(session.isIdle).toBe(false);
        expect(operation.isIdle).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* session.awaitIdle();
        expect(operation.isIdle).toBe(true);
      }),
    );
  }

  it.effect("settles text immediately on abort while source cancellation remains pending", () =>
    Effect.gen(function* () {
      const { registry, session, operation } = ownership();
      const release = yield* Deferred.make<void>();
      let cancellations = 0;
      const bounded = makeSdkFetch({
        maxBytes: 128,
        session,
        lookupOperation: registry.lookupRequestId,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel() {
                  cancellations += 1;
                  return Effect.runPromise(Deferred.await(release));
                },
              }),
            ),
          ),
      });
      const response = yield* native(() => bounded(url, request));
      const reading = yield* Effect.forkChild(settled(() => response.text()));
      yield* Effect.yieldNow;
      operation.abort();
      const result = yield* Fiber.join(reading);
      expect(Result.isFailure(result) && result.failure).toMatchObject({ name: "AbortError" });
      expect(cancellations).toBe(1);
      expect(operation.isIdle).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* session.awaitIdle();
      expect(operation.isIdle).toBe(true);
    }),
  );

  it.effect("reports streamed byte overflow before a delayed cancel settles", () =>
    Effect.gen(function* () {
      const { registry, session, operation } = ownership();
      const release = yield* Deferred.make<void>();
      const bounded = makeSdkFetch({
        maxBytes: 4,
        session,
        lookupOperation: registry.lookupRequestId,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("123456"));
                },
                cancel: () => Effect.runPromise(Deferred.await(release)),
              }),
            ),
          ),
      });
      const response = yield* native(() => bounded(url, request));
      const result = yield* settled(() => response.text());
      expect(Result.isFailure(result) && result.failure).toBeInstanceOf(SdkFetchResponseLimitError);
      expect(operation.failure).toBeInstanceOf(SdkFetchResponseLimitError);
      expect(session.isIdle).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* session.awaitIdle();
    }),
  );

  it.effect("does not treat rejected source cancellation as confirmed cleanup", () =>
    Effect.gen(function* () {
      const session = new SdkHttpTraffic();
      const bounded = makeSdkFetch({
        maxBytes: 128,
        session,
        lookupOperation: () => undefined,
        fetch: () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                cancel: () => Promise.reject(new Error("source cleanup rejected")),
              }),
            ),
          ),
      });
      const response = yield* native(() => bounded(url));
      const reading = yield* Effect.forkChild(settled(() => response.text()));
      session.abort();
      yield* Fiber.join(reading);
      expect(session.isIdle).toBe(false);
    }),
  );

  for (const method of ["GET", "DELETE", "POST"]) {
    it.effect(`owns uncorrelated ${method} traffic and rejects late admission`, () =>
      Effect.gen(function* () {
        const session = new SdkHttpTraffic();
        let cancelled = false;
        let fetches = 0;
        const bounded = makeSdkFetch({
          maxBytes: 128,
          session,
          lookupOperation: () => undefined,
          fetch: () => {
            fetches += 1;
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel() {
                    cancelled = true;
                  },
                }),
              ),
            );
          },
        });
        const response = yield* native(() => bounded(url, { method }));
        const reading = yield* Effect.forkChild(settled(() => response.text()));
        session.abort();
        yield* Fiber.join(reading);
        yield* session.awaitIdle();
        expect(cancelled).toBe(true);
        yield* settled(() => bounded(url, { method }));
        expect(fetches).toBe(1);
      }),
    );
  }

  it.effect("discards late headers after abort and ignores late operation failures", () =>
    Effect.gen(function* () {
      const { registry, session, operation } = ownership();
      const headers = yield* Deferred.make<Response>();
      const seen = yield* Deferred.make<void>();
      let cancelled = false;
      const bounded = makeSdkFetch({
        maxBytes: 128,
        session,
        lookupOperation: registry.lookupRequestId,
        fetch: () => {
          Deferred.doneUnsafe(seen, Effect.void);
          return Effect.runPromise(Deferred.await(headers));
        },
      });
      const pending = yield* Effect.forkChild(settled(() => bounded(url, request)));
      yield* Deferred.await(seen);
      operation.abort();
      expect(operation.isIdle).toBe(false);
      yield* Deferred.succeed(
        headers,
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
      const result = yield* Fiber.join(pending);
      expect(Result.isFailure(result) && result.failure).toMatchObject({ name: "AbortError" });
      yield* session.awaitIdle();
      expect(cancelled).toBe(true);
      operation.fail(new SdkFetchResponseLimitError());
      operation.responseReceived();
      expect(operation.failure).toBeUndefined();
      expect(operation.responseReceivedValue).toBe(false);
    }),
  );

  for (const body of [
    '{"jsonrpc":"2.0","method":"notifications/progress","params":{}}',
    '{"jsonrpc":"2.0","id":7,"result":{}}',
  ]) {
    it.effect(
      `bounds control body lifetime without borrowing request or GET cancellation: ${body}`,
      () =>
        Effect.gen(function* () {
          const { registry, operation, session } = ownership();
          let controlCancelled = false;
          let getCancelled = false;
          let unconfirmed = false;
          const controls = yield* makeSdkHttpControl({
            lifetimeMs: 20,
            cleanupTimeoutMs: 10,
            onUnconfirmed: () => {
              unconfirmed = true;
            },
          });
          const bounded = makeOwnedSdkFetch({
            maxBytes: 128,
            session,
            beginControl: controls.begin,
            lookupOperation: registry.lookupRequestId,
            fetch: (_url, init) =>
              Promise.resolve(
                new Response(
                  new ReadableStream<Uint8Array>({
                    cancel() {
                      if (init?.method === "GET") getCancelled = true;
                      else controlCancelled = true;
                    },
                  }),
                ),
              ),
          });
          const get = yield* native(() => bounded(url, { method: "GET" }));
          const response = yield* native(() => bounded(url, { method: "POST", body }));
          const reading = yield* Effect.forkChild(settled(() => response.text()));
          operation.abort();
          expect(controlCancelled).toBe(false);
          yield* TestClock.adjust(Duration.millis(20));
          const result = yield* Fiber.join(reading);
          expect(Result.isFailure(result) && result.failure).toMatchObject({ name: "AbortError" });
          yield* yieldUntil(() => controlCancelled);
          expect(getCancelled).toBe(false);
          expect(unconfirmed).toBe(false);
          expect(session.isIdle).toBe(false);
          yield* controls.close;
          expect(getCancelled).toBe(false);
          yield* native(() => get.body!.cancel());
          yield* session.awaitIdle();
        }),
    );
  }

  it.effect(
    "bounds control admission through uncooperative cleanup and permanently disables reuse",
    () =>
      Effect.gen(function* () {
        const session = new SdkHttpTraffic();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        let cancellations = 0;
        let unconfirmed = false;
        const controls = yield* makeSdkHttpControl({
          lifetimeMs: 20,
          cleanupTimeoutMs: 10,
          onUnconfirmed: () => {
            unconfirmed = true;
          },
        });
        const bounded = makeOwnedSdkFetch({
          maxBytes: 128,
          session,
          beginControl: controls.begin,
          lookupOperation: () => undefined,
          fetch: () => {
            fetches += 1;
            return Promise.resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  cancel() {
                    cancellations += 1;
                    return Effect.runPromise(Deferred.await(release));
                  },
                }),
              ),
            );
          },
        });
        const send = () =>
          settled(() =>
            bounded(url, {
              method: "POST",
              body: '{"jsonrpc":"2.0","method":"notifications/progress"}',
            }),
          );
        const burst = yield* Effect.forEach(Array.from({ length: 64 }), send, {
          concurrency: "unbounded",
        });
        const admitted = fetches;
        expect(admitted).toBeGreaterThan(0);
        expect(admitted).toBeLessThan(burst.length);
        expect(burst.filter(Result.isSuccess)).toHaveLength(admitted);
        yield* Effect.forEach(Array.from({ length: 64 }), send, { concurrency: "unbounded" });
        expect(fetches).toBe(admitted);
        yield* TestClock.adjust(Duration.millis(20));
        yield* yieldUntil(() => cancellations === admitted);
        expect(session.isIdle).toBe(false);
        expect(unconfirmed).toBe(false);
        expect(Result.isFailure(yield* send())).toBe(true);
        yield* TestClock.adjust(Duration.millis(10));
        yield* yieldUntil(() => unconfirmed);
        yield* Deferred.succeed(release, undefined);
        yield* session.awaitIdle();
        expect(Result.isFailure(yield* send())).toBe(true);
        expect(fetches).toBe(admitted);
        yield* controls.close;
      }),
  );
});
