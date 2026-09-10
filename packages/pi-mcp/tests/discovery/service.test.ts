import { expect, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import { boundaryError, type McpBoundaryError } from "../../src/client/errors.ts";
import type {
  McpCapabilities,
  McpMetadataFamily,
  McpReply,
  McpRequest,
} from "../../src/client/model.ts";
import type { McpEffectiveServer, McpResolvedConfig } from "../../src/config/model.ts";
import { McpConfigStore } from "../../src/config/store.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";

const server = (
  id: string,
  policy: { allowTools?: ReadonlyArray<string>; denyTools?: ReadonlyArray<string> } = {},
): McpEffectiveServer => ({
  id,
  scope: "global",
  identity: `identity-${id}`,
  directory: "/fixture",
  enabled: true,
  definition: {
    transport: "stdio",
    command: "fixture",
    args: [],
    environment: {},
    denyTools: [],
    ...policy,
  },
});
const tool = (name: string): Schema.Json => ({ name, inputSchema: { type: "object" } });
const reply = (request: McpRequest, result: Schema.Json): McpReply => ({
  action: request.action,
  outcome: "completed",
  result,
});
type Route = (request: McpRequest, id: string) => Effect.Effect<McpReply, McpBoundaryError>;
const defaultRoute: Route = (request) =>
  Effect.succeed(
    reply(
      request,
      request.action === "tools.list"
        ? { tools: [tool("alpha"), tool("beta"), tool("gamma")] }
        : request.action === "resources.list"
          ? { resources: [{ name: "r", uri: "file:///remote-only" }] }
          : request.action === "resources.templates"
            ? { resourceTemplates: [{ name: "t", uriTemplate: "https://remote/{id}" }] }
            : { prompts: [{ name: "p", arguments: [{ name: "input", required: true }] }] },
    ),
  );
const makeHarness = (
  servers = { a: server("a"), b: server("b") },
  capabilities: McpCapabilities = { tools: true, resources: false, prompts: false },
) =>
  Effect.gen(function* () {
    const config = yield* Ref.make<McpResolvedConfig>({
      revision: 1,
      trusted: true,
      diagnostics: [],
      servers,
      settings: {
        enabled: true,
        connectTimeoutMs: 15_000,
        requestTimeoutMs: 60_000,
        idleTimeoutMs: 600_000,
        maxConcurrent: 8,
        maxPerServer: 4,
        maxQueued: 64,
      },
    });
    const subscriber = yield* Ref.make<
      ((next: McpResolvedConfig) => Effect.Effect<void>) | undefined
    >(undefined);
    const route = yield* Ref.make<Route>(defaultRoute);
    const calls = yield* Ref.make<Array<{ server: string; request: McpRequest }>>([]);
    const opened = yield* Ref.make<Array<string>>([]);
    const streams = new Map<string, Queue.Queue<McpMetadataFamily, Cause.Done>>();
    const unsupported = Effect.fail(
      boundaryError("unsupported", "not-sent", "Fixture operation is unsupported."),
    );
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpConfigStore, {
        snapshot: Ref.get(config),
        subscribe: (publish) =>
          Effect.acquireRelease(Ref.set(subscriber, publish), () => Ref.set(subscriber, undefined)),
        reload: Ref.get(config),
        setServer: () => unsupported,
        removeServer: () => unsupported,
        setSettings: () => unsupported,
      }),
      Layer.succeed(McpAuth, {
        access: () => Effect.succeed(undefined),
        status: () => Effect.succeed({ state: "none" }),
        login: () => unsupported,
        logout: () => Effect.void,
        revoke: Effect.void,
      }),
      Layer.succeed(McpConnector, {
        open: (effective) =>
          Effect.gen(function* () {
            yield* Ref.update(opened, (ids) => [...ids, effective.id]);
            const queue = yield* Queue.make<McpMetadataFamily, Cause.Done>();
            streams.set(effective.id, queue);
            const terminal = yield* Deferred.make<void, McpBoundaryError>();
            const closed = yield* Ref.make(false);
            const close = Ref.set(closed, true).pipe(
              Effect.andThen(Queue.end(queue)),
              Effect.andThen(Deferred.succeed(terminal, undefined)),
              Effect.asVoid,
            );
            yield* Effect.addFinalizer(() => close);
            return {
              capabilities,
              changes: Stream.fromQueue(queue),
              terminal: Deferred.await(terminal),
              health: Ref.get(closed).pipe(
                Effect.map((done) => ({ closed: done, cleanupUnconfirmed: false })),
              ),
              setToken: () => Effect.void,
              request: (request: McpRequest) =>
                Ref.update(calls, (previous) => [
                  ...previous,
                  { server: effective.id, request },
                ]).pipe(
                  Effect.andThen(Ref.get(route)),
                  Effect.flatMap((run) => run(request, effective.id)),
                ),
              close,
            };
          }),
      }),
    );
    const connections = McpConnections.layer({ isTrusted: () => true }).pipe(
      Layer.provide(dependencies),
    );
    const layer = McpDiscovery.layer.pipe(Layer.provideMerge(connections));
    return {
      layer,
      calls,
      opened,
      route,
      notify: (id: string, family: McpMetadataFamily) =>
        Effect.gen(function* () {
          const queue = streams.get(id);
          if (queue === undefined) return yield* Effect.die("Fixture connection is missing.");
          yield* Queue.offer(queue, family);
        }),
      endChanges: (id: string) =>
        Effect.gen(function* () {
          const queue = streams.get(id);
          if (queue === undefined) return yield* Effect.die("Fixture connection is missing.");
          yield* Queue.end(queue);
        }),
      update: (change: (previous: McpResolvedConfig) => McpResolvedConfig) =>
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(config, change);
          const publish = yield* Ref.get(subscriber);
          if (publish !== undefined) yield* publish(next);
        }),
    };
  });
const Page = Schema.Struct({
  page: Schema.Struct({
    items: Schema.Array(Schema.Json),
    total: Schema.Natural,
    nextCursor: Schema.optionalKey(Schema.String),
  }),
  undiscovered: Schema.Array(Schema.String),
});
const decodePage = Schema.decodeUnknownEffect(Page);

it.effect(
  "unscoped list and search use only known metadata without connecting undiscovered servers",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        const empty = yield* discovery
          .query({ action: "tools.search", query: "" })
          .pipe(Effect.flatMap(decodePage));
        expect(empty.undiscovered).toEqual(["a", "b"]);
        expect(yield* Ref.get(harness.opened)).toEqual([]);
        yield* discovery.query({ action: "tools.list", server: "a" });
        const found = yield* discovery
          .query({ action: "tools.search", query: "ALPHA" })
          .pipe(Effect.flatMap(decodePage));
        expect(found.page.items).toHaveLength(1);
        expect(found.undiscovered).toEqual(["b"]);
        expect(yield* Ref.get(harness.opened)).toEqual(["a"]);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("deny wins across list, search and exact describe without leaking denied metadata", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      a: server("a", { allowTools: ["alpha", "beta"], denyTools: ["beta"] }),
      b: server("b", { allowTools: [] }),
    });
    yield* Effect.gen(function* () {
      const discovery = yield* McpDiscovery;
      const denied = yield* Effect.result(
        discovery.query({ action: "tools.describe", server: "a", tool: "beta" }),
      );
      expect(denied).toMatchObject({ _tag: "Failure", failure: { kind: "denied" } });
      expect(yield* Ref.get(harness.calls)).toHaveLength(0);
      const first = yield* discovery
        .query({ action: "tools.list", server: "a" })
        .pipe(Effect.flatMap(decodePage));
      expect(first.page.items).toHaveLength(1);
      expect(first.page.items).toEqual([expect.objectContaining({ name: "alpha" })]);
      const none = yield* discovery
        .query({ action: "tools.list", server: "b" })
        .pipe(Effect.flatMap(decodePage));
      expect(none.page.items).toEqual([]);
      const search = yield* discovery
        .query({ action: "tools.search", query: "beta" })
        .pipe(Effect.flatMap(decodePage));
      expect(search.page.items).toEqual([]);
      const exact = yield* Effect.result(
        discovery.query({ action: "tools.describe", server: "a", tool: "ALPHA" }),
      );
      expect(exact).toMatchObject({ _tag: "Failure", failure: { kind: "denied" } });
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "complete snapshots preserve opaque schemas and resource/prompt metadata without fetching URIs",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(undefined, {
        tools: true,
        resources: true,
        prompts: true,
      });
      yield* Ref.set(harness.route, (request, id) =>
        request.action === "tools.list"
          ? Effect.succeed(
              reply(request, {
                tools: [
                  {
                    name: "alpha",
                    inputSchema: { $ref: "https://untrusted/schema" },
                    annotations: { arbitrary: "opaque" },
                    extension: { nested: [1] },
                    server: "spoofed-server",
                  },
                ],
              }),
            )
          : defaultRoute(request, id),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        const connections = yield* McpConnections;
        const snapshot = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(snapshot.resources[0]?.uri).toEqual("file:///remote-only");
        expect(snapshot.templates[0]?.uriTemplate).toEqual("https://remote/{id}");
        expect(snapshot.prompts[0]?.arguments?.[0]?.required).toBe(true);
        expect(snapshot.tools[0]?.inputSchema).toEqual({ $ref: "https://untrusted/schema" });
        expect(snapshot.tools[0]?.extension).toEqual({ nested: [1] });
        expect(Object.isFrozen(snapshot.tools[0]?.extension)).toBe(true);
        const listing = yield* discovery
          .query({ action: "tools.list", server: "a" })
          .pipe(Effect.flatMap(decodePage));
        expect(listing.page.items).toEqual([expect.objectContaining({ server: "a" })]);
        expect((yield* Ref.get(harness.calls)).map((call) => call.request.action)).not.toContain(
          "resources.read",
        );
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("refresh failure preserves the previous complete metadata revision", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(undefined, { tools: true, resources: true, prompts: true });
    yield* Effect.gen(function* () {
      const discovery = yield* McpDiscovery;
      const connections = yield* McpConnections;
      const before = yield* connections.withOperation("a", {}, discovery.ensure);
      yield* Ref.set(harness.route, (request, id) =>
        request.action === "prompts.list"
          ? Effect.fail(boundaryError("transport", "not-sent", "Refresh failed."))
          : request.action === "tools.list"
            ? Effect.succeed(reply(request, { tools: [tool("changed")] }))
            : defaultRoute(request, id),
      );
      expect(
        yield* Effect.result(connections.withOperation("a", {}, discovery.refresh)),
      ).toMatchObject({ _tag: "Failure" });
      const after = yield* connections.withOperation("a", {}, discovery.ensure);
      expect(after).toBe(before);
      expect(after.tools.map((item) => item.name)).not.toContain("changed");
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect(
  "aggregate cursors bind every known revision, the query, and configuration revision",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        const connections = yield* McpConnections;
        yield* discovery.query({ action: "tools.list", server: "a" });
        yield* discovery.query({ action: "tools.list", server: "b" });
        const first = yield* discovery
          .query({ action: "tools.list", limit: 1 })
          .pipe(Effect.flatMap(decodePage));
        const cursor = first.page.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) return;
        const second = yield* discovery
          .query({ action: "tools.list", cursor, limit: 1 })
          .pipe(Effect.flatMap(decodePage));
        expect(second.page.items).not.toEqual(first.page.items);
        expect(
          yield* Effect.result(discovery.query({ action: "tools.search", query: "", cursor })),
        ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        yield* connections.withOperation("b", {}, discovery.refresh);
        expect(
          yield* Effect.result(discovery.query({ action: "tools.list", cursor })),
        ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        const current = yield* discovery
          .query({ action: "tools.list", limit: 1 })
          .pipe(Effect.flatMap(decodePage));
        yield* harness.update((config) => ({ ...config, revision: 2 }));
        if (current.page.nextCursor !== undefined)
          expect(
            yield* Effect.result(
              discovery.query({ action: "tools.list", cursor: current.page.nextCursor }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        expect(yield* discovery.known).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "cancelling the first waiter does not cancel a shared metadata owner or its second waiter",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      yield* Ref.set(harness.route, (request, id) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(defaultRoute(request, id)),
        ),
      );
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        const first = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        yield* Deferred.await(started);
        const second = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(finish, undefined);
        const result = yield* Fiber.join(second).pipe(Effect.flatMap(decodePage));
        expect(result.page.total).toBe(3);
        expect(yield* Ref.get(harness.calls)).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "list changes coalesce under one connection-owned consumer after the discovery caller closes",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refreshed = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        yield* discovery.query({ action: "tools.list", server: "a" });
        yield* discovery.query({ action: "tools.list", server: "a" });
        yield* Ref.set(harness.route, (request) =>
          Deferred.succeed(refreshed, undefined).pipe(
            Effect.as(reply(request, { tools: [tool("changed")] })),
          ),
        );
        yield* harness.notify("a", "tools");
        yield* harness.notify("a", "resources");
        yield* harness.notify("a", "prompts");
        yield* TestClock.adjust("30 millis");
        yield* Deferred.await(refreshed);
        const found = yield* discovery
          .query({ action: "tools.list", server: "a" })
          .pipe(Effect.flatMap(decodePage));
        expect(found.page.items).toEqual([expect.objectContaining({ name: "changed" })]);
        expect(yield* Ref.get(harness.calls)).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect(
  "revocation removes known metadata and blocks an in-flight refresh from republishing",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        const discovery = yield* McpDiscovery;
        const connections = yield* McpConnections;
        yield* discovery.query({ action: "tools.list", server: "a" });
        yield* Ref.set(harness.route, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        );
        const pending = yield* Effect.forkScoped(
          connections.withOperation("a", {}, discovery.refresh),
        );
        yield* Deferred.await(started);
        yield* connections.revoke("a");
        expect(yield* discovery.known).toEqual([]);
        expect(yield* Fiber.await(pending)).toMatchObject({ _tag: "Failure" });
        const known = yield* discovery
          .query({ action: "tools.list" })
          .pipe(Effect.flatMap(decodePage));
        expect(known.page.items).toEqual([]);
      }).pipe(Effect.provide(harness.layer));
    }),
);

it.effect("an expired notification owner cannot be repopulated by a late refresh", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const discovery = yield* McpDiscovery;
      const connections = yield* McpConnections;
      yield* discovery.query({ action: "tools.list", server: "a" });
      yield* Ref.set(harness.route, (request, id) =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.andThen(defaultRoute(request, id)),
        ),
      );
      const pending = yield* Effect.forkScoped(
        connections.withOperation("a", {}, discovery.refresh),
      );
      yield* Deferred.await(started);
      yield* harness.endChanges("a");
      yield* TestClock.adjust("30 millis");
      expect(yield* discovery.known).toEqual([]);
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Effect.result(Fiber.join(pending))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "stale" },
      });
      expect(yield* discovery.known).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  }),
);

it.effect("targeted queries reuse an existing admission and reject a mismatched operation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* Effect.gen(function* () {
      const discovery = yield* McpDiscovery;
      const connections = yield* McpConnections;
      const result = yield* connections.withOperation("a", {}, (operation) =>
        discovery.query({ action: "tools.describe", server: "a", tool: "alpha" }, operation),
      );
      expect(result).toMatchObject({ name: "alpha" });
      const missing = yield* Effect.result(
        discovery.query({ action: "tools.describe", server: "a", tool: "ALPHA" }),
      );
      expect(missing).toMatchObject({ _tag: "Failure", failure: { kind: "not-found" } });
      const mismatch = yield* Effect.result(
        connections.withOperation("a", {}, (operation) =>
          discovery.query({ action: "tools.list", server: "b" }, operation),
        ),
      );
      expect(mismatch).toMatchObject({ _tag: "Failure", failure: { kind: "invalid-input" } });
      expect(yield* Ref.get(harness.opened)).toEqual(["a"]);
    }).pipe(Effect.provide(harness.layer));
  }),
);
