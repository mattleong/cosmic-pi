import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { SUBSCRIPTION_ID_META_KEY } from "@modelcontextprotocol/client";
import { yieldUntil } from "pi-cosmic-core/testing";
import { McpExecution } from "../../src/tools/service.ts";
import type { ConnectionOwner } from "../../src/connection/registry.ts";
import type { McpConnection } from "../../src/client/model.ts";
import { makeResourceSubscriptions } from "../../src/resources/subscriptions.ts";
import { optionalFixture, projection } from "../fixtures/optional-features.ts";

const resourceOwner = (
  check: (opened: number) => Effect.Effect<void> = () => Effect.void,
  lease: (delta: number) => Effect.Effect<void> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const owner: ConnectionOwner = {
      id: "owner",
      server: {
        id: "fixture",
        identity: "fixture",
        enabled: true,
        scope: "global",
        directory: "/fixture",
      },
      scope: yield* Scope.fork(yield* Effect.scope),
      ready: Deferred.makeUnsafe(),
      cleaned: Deferred.makeUnsafe(),
      shared: new Map(),
      state: "connected",
      current: true,
      accepting: true,
      operations: 0,
      leases: 0,
      authorizationRevision: 0,
      authorizationToken: undefined,
      idleGeneration: 0,
      uncertain: false,
    };
    const counts = { opened: 0, closed: 0 };
    const identities: symbol[] = [];
    const subscriptions = yield* makeResourceSubscriptions({
      check: () => check(counts.opened),
      lease: (_, delta) =>
        Effect.sync(() => {
          owner.leases += delta;
        }).pipe(Effect.andThen(lease(delta))),
      failed: () =>
        Effect.sync(() => {
          owner.uncertain = true;
        }),
    });
    yield* subscriptions.own(owner);
    const connection: McpConnection = {
      capabilities: { tools: false, resources: true, prompts: false, resourceSubscriptions: true },
      changes: Stream.empty,
      terminal: Effect.never,
      health: Effect.succeed({ closed: false, cleanupUnconfirmed: false }),
      setToken: () => Effect.void,
      request: () => Effect.die("unused"),
      close: Effect.void,
      subscribeResource: (_, identity = Symbol("owned resource")) =>
        Effect.gen(function* () {
          identities.push(identity);
          counts.opened++;
          const closed = yield* Deferred.make<void>();
          const close = yield* Effect.cached(
            Effect.sync(() => {
              counts.closed++;
              Deferred.doneUnsafe(closed, Effect.void);
            }),
          );
          yield* Effect.addFinalizer(() => close);
          return { identity, close, closed: Deferred.await(closed) };
        }),
    };
    return { owner, counts, identities, subscriptions, connection };
  });

// Public Scope state exposes the live cleanup footprint. This regression bounds
// retained cleanup closures across real subscribe/unsubscribe cycles, not an exact
// Effect finalizer layout or a particular number of child-scope registrations.
const cleanupFootprint = (scope: Scope.Scope) => {
  const state = scope.state;
  return state._tag === "Open"
    ? Number(state.finalizer !== undefined) + (state.finalizers?.size ?? 0)
    : 0;
};

it.effect(
  "repeated resource leases retain bounded owner cleanup and close only live resources",
  () =>
    Effect.gen(function* () {
      const { owner, counts, subscriptions, connection } = yield* resourceOwner();
      const baseline = cleanupFootprint(owner.scope);
      for (let cycle = 0; cycle < 100; cycle++) {
        yield* subscriptions.subscribe(owner, connection, "test://one");
        yield* subscriptions.unsubscribe("fixture", "test://one");
        yield* Effect.yieldNow;
        expect(owner.leases).toBe(0);
        expect(counts.closed).toBe(cycle + 1);
        expect(cleanupFootprint(owner.scope)).toBeLessThanOrEqual(baseline + 2);
      }
      yield* subscriptions.subscribe(owner, connection, "test://one");
      yield* subscriptions.subscribe(owner, connection, "test://two");
      yield* Scope.close(owner.scope, Exit.void);
      expect(owner.leases).toBe(0);
      expect(counts).toEqual({ opened: 102, closed: 102 });
      expect((yield* subscriptions.status("fixture")).subscriptions).toEqual([]);
      yield* subscriptions.unsubscribe("fixture", "test://one");
      expect(counts.closed).toBe(102);
    }),
);

it.effect(
  "owner closure joins acquisition holding the lease transition without a finalizer-registration deadlock",
  () =>
    Effect.gen(function* () {
      const acquired = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const { owner, counts, subscriptions, connection } = yield* resourceOwner(
        undefined,
        (delta) =>
          delta > 0
            ? Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
      );
      const opening = yield* Effect.forkScoped(
        subscriptions.subscribe(owner, connection, "test://one").pipe(Effect.exit),
      );
      yield* Deferred.await(acquired);
      let finished = false;
      const closing = yield* Effect.forkScoped(
        Scope.close(owner.scope, Exit.void).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              finished = true;
            }),
          ),
        ),
      );
      yield* Effect.yieldNow;
      expect(finished).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      expect(Exit.isFailure(yield* Fiber.join(opening))).toBe(true);
      expect(owner.leases).toBe(0);
      expect(counts.closed).toBe(counts.opened);
      expect((yield* subscriptions.status("fixture")).subscriptions).toEqual([]);
    }),
);

for (const cancel of [false, true])
  it.effect(
    `resource event handoff waits for owner check and rejects cancelled readiness; cancel=${cancel}`,
    () =>
      Effect.gen(function* () {
        const checking = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const { owner, identities, subscriptions, connection } = yield* resourceOwner((opened) =>
          opened > 0
            ? Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(release)))
            : Effect.void,
        );
        const opening = yield* Effect.forkScoped(
          subscriptions.subscribe(owner, connection, "test://one").pipe(Effect.exit),
        );
        yield* Deferred.await(checking);
        let delivered = false;
        const waiting = yield* Effect.forkScoped(
          subscriptions.awaitReady(owner, "test://one", identities[0]).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                delivered = true;
              }),
            ),
          ),
        );
        yield* Effect.yieldNow;
        expect(delivered).toBe(false);
        if (cancel) yield* subscriptions.unsubscribe("fixture", "test://one");
        else yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(waiting);
        const opened = yield* Fiber.join(opening);
        expect(Exit.isSuccess(opened)).toBe(!cancel);
        expect((yield* subscriptions.status("fixture")).subscriptions).toHaveLength(cancel ? 0 : 1);
      }),
  );

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const subscribe = { action: "resources.subscribe", server: "fixture", uri: "test://one" };
const status = { action: "resources.subscriptions", server: "fixture" };
const unsubscribe = { action: "resources.unsubscribe", server: "fixture", uri: "test://one" };
const awaitResourceEvents = (count: number) =>
  Effect.gen(function* () {
    const execution = yield* McpExecution;
    const read = execution.execute({ action: "events.read", server: "fixture" }, projection).pipe(
      Effect.flatMap(({ reply }) =>
        Schema.decodeUnknownEffect(
          Schema.Struct({
            result: Schema.Struct({
              ingressDropped: Schema.Finite,
              events: Schema.Array(
                Schema.Struct({ kind: Schema.String, uri: Schema.String, cursor: Schema.String }),
              ),
            }),
          }),
        )(reply.data),
      ),
      Effect.map(({ result }) => result),
    );
    return yield* read.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("1 millis"),
        until: (result) => result.events.length >= count,
      }),
      Effect.timeout("1 second"),
    );
  });

const streams = (
  ack = true,
  cancel?: () => Promise<void>,
  extra: NonNullable<Parameters<typeof optionalFixture>[1]> = {},
  pendingIndex = -1,
) => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const ids: (string | number)[] = [];
  let cancelled = 0;
  const fixture = optionalFixture(
    (request) => {
      if (request.method !== "subscriptions/listen") return undefined;
      ids.push(request.id!);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controllers.push(controller);
            if (ack && ids.length - 1 !== pendingIndex)
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${serialize({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: request.params?.notifications, _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id } } })}\n\n`,
                ),
              );
          },
          cancel() {
            cancelled++;
            return cancel?.();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    { settings: { idleTimeoutMs: 20 }, ...extra },
  );
  return { fixture, controllers, ids, cancelled: () => cancelled };
};

it.live(
  "stale queued generations never wait for a replacement ACK or block other resource updates",
  () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<void>();
      const delivery = yield* Deferred.make<void>();
      let paused = false;
      const owned = streams(
        true,
        undefined,
        {
          mapConnection: (connection) => ({
            ...connection,
            remoteEvents: connection.remoteEvents!.pipe(
              Stream.mapEffect((event) => {
                if (paused) return Effect.succeed(event);
                paused = true;
                return Deferred.succeed(captured, undefined).pipe(
                  Effect.andThen(Deferred.await(delivery)),
                  Effect.as(event),
                );
              }),
            ),
          }),
        },
        2,
      );
      const emit = (index: number, uri: string) =>
        owned.controllers[index]!.enqueue(
          new TextEncoder().encode(
            `data: ${serialize({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri, _meta: { [SUBSCRIPTION_ID_META_KEY]: owned.ids[index] } } })}\n\n`,
          ),
        );
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        yield* execution.execute(subscribe, projection);
        yield* execution.execute({ ...subscribe, uri: "test://two" }, projection);
        emit(0, "test://one");
        yield* Deferred.await(captured);
        yield* execution.execute(unsubscribe, projection);
        const replacement = yield* Effect.forkScoped(
          execution.execute(subscribe, projection).pipe(Effect.exit),
        );
        yield* yieldUntil(() => owned.ids.length === 3);
        yield* Deferred.succeed(delivery, undefined);
        emit(1, "test://two");
        expect(yield* awaitResourceEvents(1)).toMatchObject({
          events: [{ kind: "resource-updated", uri: "test://two", cursor: expect.any(String) }],
        });
        yield* execution.execute(unsubscribe, projection);
        expect(Exit.isFailure(yield* Fiber.join(replacement))).toBe(true);
      }).pipe(
        Effect.ensuring(Deferred.succeed(delivery, undefined)),
        Effect.provide(owned.fixture.layer),
      );
    }),
);

const adjacentStream = (
  honored = true,
  burst = 1,
  mapConnection?: NonNullable<Parameters<typeof optionalFixture>[1]>["mapConnection"],
) =>
  optionalFixture(
    (request) => {
      if (request.method !== "subscriptions/listen") return undefined;
      const update = (id: string | number, uri = "test://one") => ({
        jsonrpc: "2.0",
        method: "notifications/resources/updated",
        params: { uri, _meta: { [SUBSCRIPTION_ID_META_KEY]: id } },
      });
      const messages = [
        update(request.id!), // Pre-ACK data must not be staged.
        {
          jsonrpc: "2.0",
          method: "notifications/subscriptions/acknowledged",
          params: {
            notifications: honored
              ? request.params?.notifications
              : { resourceSubscriptions: ["test://one"], toolsListChanged: true },
            _meta: { [SUBSCRIPTION_ID_META_KEY]: request.id },
          },
        },
        update("never-owned"),
        update(request.id!, "test://unrequested"),
        ...Array.from({ length: burst }, () => update(request.id!)),
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                messages.map((message) => `data: ${serialize(message)}\n\n`).join(""),
              ),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
    mapConnection ? { mapConnection } : {},
  );

for (const cancel of [false, true])
  it.live(
    `ACK-adjacent HTTP updates wait for handle publication without holding the registry lock; cancel=${cancel}`,
    () =>
      Effect.gen(function* () {
        const captured = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const fixture = adjacentStream(true, 1, (connection) => ({
          ...connection,
          subscribeResource: (uri, identity) =>
            connection.subscribeResource!(uri, identity).pipe(
              Effect.tap(() =>
                Deferred.succeed(captured, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
            ),
        }));
        yield* Effect.gen(function* () {
          const execution = yield* McpExecution;
          const opening = yield* Effect.forkScoped(
            execution.execute(subscribe, projection).pipe(Effect.exit),
          );
          yield* Deferred.await(captured);
          yield* Effect.sleep(10);
          expect(
            (yield* execution.execute({ action: "events.read", server: "fixture" }, projection))
              .reply.data,
          ).toMatchObject({ result: { events: [] } });
          if (cancel) yield* execution.execute(unsubscribe, projection);
          else yield* Deferred.succeed(release, undefined);
          expect(Exit.isSuccess(yield* Fiber.join(opening))).toBe(!cancel);
          if (cancel) {
            yield* Effect.sleep(10);
            expect(
              (yield* execution.execute({ action: "events.read", server: "fixture" }, projection))
                .reply.data,
            ).toMatchObject({ result: { events: [] } });
          } else {
            expect(yield* awaitResourceEvents(1)).toMatchObject({
              events: [{ kind: "resource-updated", uri: "test://one", cursor: expect.any(String) }],
            });
          }
        }).pipe(
          Effect.ensuring(Deferred.succeed(release, undefined)),
          Effect.provide(fixture.layer),
        );
      }),
  );

for (const [code, kind, reason] of [
  [-32602, "protocol", "rpc-invalid-params"],
  [-32601, "unsupported", "rpc-method-not-found"],
] as const)
  it.live(`a rejected HTTP subscription preserves completed certainty for ${code}`, () => {
    const secret = "private-server-message-and-data";
    const fixture = optionalFixture((request) =>
      request.method === "subscriptions/listen"
        ? new Response(
            serialize({
              jsonrpc: "2.0",
              id: request.id,
              error: { code, message: secret, data: { secret } },
            }),
            { headers: { "content-type": "application/json" } },
          )
        : undefined,
    );
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      const error = yield* execution.execute(subscribe, projection).pipe(Effect.flip);
      expect(error).toMatchObject({ kind, outcome: "completed", reason });
      expect(serialize(error)).not.toContain(secret);
      expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
        result: { subscriptions: [] },
      });
      expect(
        fixture.requests.filter((request) => request.method === "subscriptions/listen"),
      ).toHaveLength(1);
      expect(fixture.opens()).toBe(1);
    }).pipe(Effect.provide(fixture.layer));
  });

it.live("rejected honored filters discard ACK-adjacent updates", () => {
  const fixture = adjacentStream(false);
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    expect(yield* execution.execute(subscribe, projection).pipe(Effect.flip)).toMatchObject({
      kind: "protocol",
      outcome: "completed",
    });
    yield* Effect.sleep(10);
    expect(
      (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
        .data,
    ).toMatchObject({ result: { events: [] } });
    expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
      result: { subscriptions: [] },
    });
  }).pipe(Effect.provide(fixture.layer));
});

it.live("ACK-adjacent staging stays bounded and discloses overflow", () => {
  const fixture = adjacentStream(true, 40);
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    yield* execution.execute(subscribe, projection);
    const result = yield* awaitResourceEvents(32);
    expect(result.ingressDropped).toBeGreaterThanOrEqual(8);
    expect(result.events).toHaveLength(32);
    expect(
      result.events.every(
        (event) => event.kind === "resource-updated" && event.uri === "test://one",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(fixture.layer));
});

it.live(
  "deduplicates acknowledged leases, prevents idle retirement and never acquires for local cancellation/status",
  () => {
    const owned = streams();
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      yield* execution.execute(status, projection);
      yield* execution.execute(unsubscribe, projection);
      expect(owned.fixture.opens()).toBe(0);
      yield* execution.execute(subscribe, projection);
      yield* execution.execute(subscribe, projection);
      expect(owned.ids).toHaveLength(1);
      yield* Effect.sleep(80);
      expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
        result: { subscriptions: [{ uri: "test://one", state: "active" }] },
      });
      owned.controllers[0]!.enqueue(
        new TextEncoder().encode(
          `data: ${serialize({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one", _meta: { [SUBSCRIPTION_ID_META_KEY]: owned.ids[0] } } })}\n\n`,
        ),
      );
      expect(yield* awaitResourceEvents(1)).toMatchObject({
        events: [expect.objectContaining({ kind: "resource-updated", uri: "test://one" })],
      });
      expect(owned.fixture.requests.some((request) => request.method === "resources/read")).toBe(
        false,
      );
      yield* execution.execute(unsubscribe, projection);
      expect(owned.cancelled()).toBe(1);
      expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
        result: { subscriptions: [] },
      });
      yield* Effect.sleep(80);
      yield* execution.execute(unsubscribe, projection);
      expect(owned.fixture.opens()).toBe(1);
    }).pipe(Effect.provide(owned.fixture.layer));
  },
);

it.live("lost subscriptions withdraw authority without automatic re-listening", () => {
  const owned = streams();
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    yield* execution.execute(subscribe, projection);
    owned.controllers[0]!.close();
    yield* Effect.sleep(30);
    expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
      result: { subscriptions: [] },
    });
    expect(owned.ids).toHaveLength(1);
  }).pipe(Effect.provide(owned.fixture.layer));
});

it.live("unsubscribe cancels pending acknowledgement and joins source cleanup", () => {
  const owned = streams(false);
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    const pending = yield* Effect.forkScoped(
      execution.execute(subscribe, projection).pipe(Effect.result),
    );
    yield* yieldUntil(() => owned.ids.length === 1);
    yield* execution.execute(unsubscribe, projection);
    yield* Fiber.interrupt(pending);
    expect(owned.cancelled()).toBe(1);
    expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
      result: { subscriptions: [] },
    });
    expect(owned.fixture.opens()).toBe(1);
  }).pipe(Effect.provide(owned.fixture.layer));
});

it.live("connection revocation closes all resource streams and rejects late observations", () => {
  const owned = streams();
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    yield* execution.execute(subscribe, projection);
    yield* execution.execute({ ...subscribe, uri: "test://two" }, projection);
    yield* execution.execute({ action: "disconnect", server: "fixture" }, projection);
    expect(owned.cancelled()).toBe(2);
    expect((yield* execution.execute(status, projection)).reply.data).toMatchObject({
      result: { subscriptions: [] },
    });
    expect(
      (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
        .data,
    ).toMatchObject({ result: { events: [] } });
  }).pipe(Effect.provide(owned.fixture.layer));
});

for (const settle of [true, false])
  it.live(`modern unsubscribe waits for native source cancellation; settles=${settle}`, () =>
    Effect.gen(function* () {
      const cancelling = yield* Deferred.make<void>();
      const held = yield* Deferred.make<void>();
      const runForeign = Effect.runPromiseWith(yield* Effect.context<never>());
      const release = () => Deferred.doneUnsafe(held, Effect.void);
      const owned = streams(true, () => {
        Deferred.doneUnsafe(cancelling, Effect.void);
        return runForeign(Deferred.await(held));
      });
      yield* Effect.gen(function* () {
        const execution = yield* McpExecution;
        yield* execution.execute(subscribe, projection);
        let completed = false;
        const closing = yield* Effect.forkScoped(
          execution.execute(unsubscribe, projection).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                completed = true;
              }),
            ),
          ),
        );
        yield* Deferred.await(cancelling);
        yield* Effect.sleep(20);
        expect(completed).toBe(false);
        if (settle) {
          release!();
          expect((yield* Fiber.join(closing)).reply).toMatchObject({
            outcome: "completed",
            isError: false,
          });
          yield* execution.execute(subscribe, projection);
          expect(owned.ids).toHaveLength(2);
        } else {
          expect(yield* Fiber.join(closing).pipe(Effect.flip)).toMatchObject({
            outcome: "unknown",
            kind: "cleanup",
          });
          release!();
          expect(yield* execution.execute(subscribe, projection).pipe(Effect.flip)).toMatchObject({
            outcome: "not-sent",
          });
          expect(owned.ids).toHaveLength(1);
          expect(owned.fixture.opens()).toBe(1);
        }
      }).pipe(Effect.ensuring(Effect.sync(release)), Effect.provide(owned.fixture.layer));
    }),
  );

it.live(
  "legacy unacknowledged establishment joins HTTP source cleanup and fences replacement",
  () => {
    const opened = Deferred.makeUnsafe<void>();
    let cancelled = 0;
    const fixture = optionalFixture(
      (request) => {
        if (request.method === "initialize")
          return new Response(
            serialize({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { resources: { subscribe: true } },
                serverInfo: { name: "fixture", version: "1" },
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        if (request.method !== "resources/subscribe") return undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            start() {
              Deferred.doneUnsafe(opened, Effect.void);
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
      { protocol: "legacy" },
    );
    return Effect.gen(function* () {
      const execution = yield* McpExecution;
      const pending = yield* Effect.forkScoped(execution.execute(subscribe, projection));
      yield* Deferred.await(opened);
      expect(yield* execution.execute(unsubscribe, projection).pipe(Effect.flip)).toMatchObject({
        outcome: "unknown",
        kind: "cleanup",
      });
      expect(cancelled).toBe(1);
      expect(yield* Fiber.join(pending).pipe(Effect.flip)).toMatchObject({ outcome: "unknown" });
      expect(yield* execution.execute(subscribe, projection).pipe(Effect.flip)).toMatchObject({
        outcome: "not-sent",
      });
      expect(fixture.opens()).toBe(1);
    }).pipe(Effect.provide(fixture.layer));
  },
);

it.live("drops wrong subscription IDs before SDK metadata stripping", () => {
  const owned = streams();
  return Effect.gen(function* () {
    const execution = yield* McpExecution;
    yield* execution.execute(subscribe, projection);
    owned.controllers[0]!.enqueue(
      new TextEncoder().encode(
        `data: ${serialize({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one", _meta: { [SUBSCRIPTION_ID_META_KEY]: "listen:never-existed" } } })}\n\n`,
      ),
    );
    yield* Effect.sleep(20);
    expect(
      (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
        .data,
    ).toMatchObject({ result: { events: [] } });
  }).pipe(Effect.provide(owned.fixture.layer));
});

it.live("a queued old subscription generation cannot revive after same-URI replacement", () =>
  Effect.gen(function* () {
    const captured = yield* Deferred.make<void>();
    const delivery = yield* Deferred.make<void>();
    let paused = false;
    const owned = streams(true, undefined, {
      mapConnection: (connection) => ({
        ...connection,
        remoteEvents: connection.remoteEvents!.pipe(
          Stream.mapEffect((event) => {
            if (paused) return Effect.succeed(event);
            paused = true;
            return Deferred.succeed(captured, undefined).pipe(
              Effect.andThen(Deferred.await(delivery)),
              Effect.as(event),
            );
          }),
        ),
      }),
    });
    const emit = (index: number) =>
      owned.controllers[index]!.enqueue(
        new TextEncoder().encode(
          `data: ${serialize({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "test://one", _meta: { [SUBSCRIPTION_ID_META_KEY]: owned.ids[index] } } })}\n\n`,
        ),
      );
    yield* Effect.gen(function* () {
      const execution = yield* McpExecution;
      yield* execution.execute(subscribe, projection);
      emit(0);
      yield* Deferred.await(captured);
      yield* execution.execute(unsubscribe, projection);
      yield* execution.execute(subscribe, projection);
      yield* Deferred.succeed(delivery, undefined);
      yield* Effect.sleep(10);
      expect(
        (yield* execution.execute({ action: "events.read", server: "fixture" }, projection)).reply
          .data,
      ).toMatchObject({ result: { events: [] } });
      emit(1);
      expect(yield* awaitResourceEvents(1)).toMatchObject({
        events: [{ kind: "resource-updated", uri: "test://one", cursor: expect.any(String) }],
      });
    }).pipe(
      Effect.ensuring(Deferred.succeed(delivery, undefined)),
      Effect.provide(owned.fixture.layer),
    );
  }),
);
