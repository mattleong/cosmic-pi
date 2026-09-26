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
import { yieldUntil } from "pi-cosmic-core/testing";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import { boundaryError, type McpBoundaryError } from "../../src/client/errors.ts";
import type {
  McpCapabilities,
  McpMetadataFamily,
  McpReply,
  McpRequest,
} from "../../src/client/model.ts";
import type { McpResolvedConfig } from "../../src/config/model.ts";
import { McpConnections } from "../../src/connection/service.ts";
import type { McpOperation } from "../../src/connection/model.ts";
import { McpDiscovery } from "../../src/discovery/service.ts";
import { gate } from "../fixtures/probes.ts";
import {
  fakeAuth,
  fakeConfigStore,
  fakeConnection,
  runWith,
  stdioDefinition,
  testConfig,
  testServer,
} from "../fixtures/services.ts";
import type {
  McpDiscoveryContract,
  McpDiscoveryQueryResult,
  McpDiscoveryRequest,
} from "../../src/discovery/model.ts";

const server = (
  id: string,
  policy: { allowTools?: ReadonlyArray<string>; denyTools?: ReadonlyArray<string> } = {},
) => testServer(id, { definition: stdioDefinition(policy) });
const tool = (name: string): Schema.Json => ({ name, inputSchema: { type: "object" } });
const reply = (request: McpRequest, result: Schema.JsonObject): McpReply => ({
  action: request.action,
  outcome: "completed",
  result: { ttlMs: 60_000, ...result },
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
  servers: McpResolvedConfig["servers"] = { a: server("a"), b: server("b") },
  capabilities: McpCapabilities = { tools: true, resources: false, prompts: false },
) =>
  Effect.gen(function* () {
    const store = fakeConfigStore(testConfig({ servers }));
    const route = yield* Ref.make<Route>(defaultRoute);
    const calls = yield* Ref.make<Array<{ server: string; request: McpRequest }>>([]);
    const opened = yield* Ref.make<Array<string>>([]);
    const streams = new Map<string, Queue.Queue<McpMetadataFamily, Cause.Done>>();
    const activity = McpActivity.layer();
    const dependencies = Layer.mergeAll(
      activity,
      store.layer,
      Layer.succeed(McpAuth, fakeAuth()),
      Layer.succeed(McpConnector, {
        open: (effective) =>
          Effect.gen(function* () {
            yield* Ref.update(opened, (ids) => [...ids, effective.id]);
            const queue = yield* Queue.make<McpMetadataFamily, Cause.Done>();
            streams.set(effective.id, queue);
            return yield* fakeConnection((terminal) => ({
              capabilities,
              changes: Stream.fromQueue(queue),
              close: Queue.end(queue).pipe(
                Effect.andThen(Deferred.succeed(terminal, undefined)),
                Effect.asVoid,
              ),
              request: (request) =>
                Ref.update(calls, (previous) => [
                  ...previous,
                  { server: effective.id, request },
                ]).pipe(
                  Effect.andThen(Ref.get(route)),
                  Effect.flatMap((run) => run(request, effective.id)),
                ),
            }));
          }),
      }),
    );
    const connections = McpConnections.layer({ isTrusted: () => true }).pipe(
      Layer.provide(dependencies),
    );
    const layer = McpDiscovery.layer.pipe(
      Layer.provideMerge(Layer.mergeAll(connections, activity)),
    );
    return {
      run: runWith(
        Effect.all({
          discovery: Effect.service(McpDiscovery),
          connections: Effect.service(McpConnections),
        }),
        layer,
      ),
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
        Effect.suspend(() => store.publish(change(store.current()))),
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
const decodePage = (result: McpDiscoveryQueryResult) =>
  Schema.decodeUnknownEffect(Page)(result.data);
const queryPage = (
  discovery: McpDiscoveryContract,
  request: McpDiscoveryRequest,
  operation?: McpOperation,
) => discovery.query(request, operation).pipe(Effect.flatMap(decodePage));

it.effect(
  "unscoped list and search use only known metadata without connecting undiscovered servers",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(function* ({ discovery }) {
        const empty = yield* queryPage(discovery, { action: "tools.search", query: "" });
        expect(empty.page).toMatchObject({ items: [], total: 0 });
        expect(empty.undiscovered).toEqual(["a", "b"]);
        expect(yield* Ref.get(harness.opened)).toEqual([]);
        yield* discovery.query({ action: "tools.list", server: "a" });
        const found = yield* queryPage(discovery, { action: "tools.search", query: "ALPHA" });
        expect(found.page.items).toHaveLength(1);
        expect(found.undiscovered).toEqual(["b"]);
        expect(yield* Ref.get(harness.opened)).toEqual(["a"]);
      });
    }),
);

it.effect("deny wins across list, search and exact describe without leaking denied metadata", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      a: server("a", { allowTools: ["alpha", "beta"], denyTools: ["beta"] }),
      b: server("b", { allowTools: [] }),
    });
    yield* harness.run(function* ({ discovery }) {
      const denied = yield* Effect.result(
        discovery.query({ action: "tools.describe", server: "a", tool: "beta" }),
      );
      expect(denied).toMatchObject({ _tag: "Failure", failure: { kind: "denied" } });
      expect(yield* Ref.get(harness.calls)).toHaveLength(0);
      const first = yield* queryPage(discovery, { action: "tools.list", server: "a" });
      expect(first.page.items).toHaveLength(1);
      expect(first.page.items).toEqual([expect.objectContaining({ name: "alpha" })]);
      const none = yield* queryPage(discovery, { action: "tools.list", server: "b" });
      expect(none.page.items).toEqual([]);
      const search = yield* queryPage(discovery, { action: "tools.search", query: "beta" });
      expect(search.page.items).toEqual([]);
      const exact = yield* Effect.result(
        discovery.query({ action: "tools.describe", server: "a", tool: "ALPHA" }),
      );
      expect(exact).toMatchObject({ _tag: "Failure", failure: { kind: "denied" } });
    });
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
      yield* harness.run(function* ({ discovery, connections }) {
        const snapshot = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(snapshot.resources[0]?.uri).toEqual("file:///remote-only");
        expect(snapshot.templates[0]?.uriTemplate).toEqual("https://remote/{id}");
        expect(snapshot.prompts[0]?.arguments?.[0]?.required).toBe(true);
        expect(snapshot.tools[0]?.inputSchema).toEqual({ $ref: "https://untrusted/schema" });
        expect(snapshot.tools[0]?.extension).toEqual({ nested: [1] });
        expect(Object.isFrozen(snapshot.tools[0]?.extension)).toBe(true);
        const listing = yield* queryPage(discovery, { action: "tools.list", server: "a" });
        expect(listing.page.items).toEqual([{ server: "a", name: "alpha" }]);
        const described = yield* discovery.query({
          action: "tools.describe",
          server: "a",
          tool: "alpha",
        });
        expect(described.data).toBe(snapshot.tools[0]);
        for (const [action, entries] of [
          ["resources.list", snapshot.resources],
          ["resources.templates", snapshot.templates],
          ["prompts.list", snapshot.prompts],
        ] as const) {
          const page = yield* queryPage(discovery, { action, server: "a" });
          expect(page.page.items).toEqual(entries);
        }
        expect((yield* Ref.get(harness.calls)).map((call) => call.request.action)).not.toContain(
          "resources.read",
        );
      });
    }),
);

it.effect("keeps tools when advertised resource listings are unavailable", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      { a: server("a") },
      { tools: true, resources: true, prompts: false },
    );
    yield* Ref.set(harness.route, (request, id) =>
      request.action === "resources.list" || request.action === "resources.templates"
        ? Effect.fail(
            boundaryError(
              "unsupported",
              "completed",
              "private-server-message",
              "rpc-method-not-found",
            ),
          )
        : defaultRoute(request, id),
    );
    yield* harness.run(function* ({ discovery, connections }) {
      const snapshot = yield* connections.withOperation("a", {}, discovery.ensure);
      expect(snapshot.tools.map((entry) => entry.name)).toEqual(["alpha", "beta", "gamma"]);
      expect(snapshot.support).toEqual({
        tools: true,
        resources: false,
        templates: false,
        prompts: false,
      });
      expect(snapshot.diagnostics).toEqual([
        { family: "resources", reason: "rpc-method-not-found" },
        { family: "templates", reason: "rpc-method-not-found" },
      ]);
      expect((yield* discovery.cached({ family: "resources" })).catalogs[0]).toMatchObject({
        state: "unsupported",
        reason: "rpc-method-not-found",
      });
      const described = yield* discovery.query({
        action: "tools.describe",
        server: "a",
        tool: "alpha",
      });
      expect(described.data).toEqual(tool("alpha"));
      expect(described.notices).toHaveLength(2);
      expect(described.notices.join("\n")).not.toContain("private-");
      for (const request of [
        { action: "tools.list", limit: 1 },
        { action: "tools.search", query: "a", limit: 1 },
      ] as const) {
        const first = yield* discovery.query(request);
        const page = yield* decodePage(first);
        expect(first.notices).toEqual(described.notices);
        expect(page.page.items[0]).not.toHaveProperty("inputSchema");
        const next = yield* discovery.query({ ...request, cursor: page.page.nextCursor! });
        expect(next.notices).toEqual(first.notices);
      }
      expect((yield* discovery.known)[0]?.diagnostics).toEqual(snapshot.diagnostics);
      const count = (yield* Ref.get(harness.calls)).length;
      expect(yield* connections.withOperation("a", {}, discovery.ensure)).toBe(snapshot);
      expect(yield* Ref.get(harness.calls)).toHaveLength(count);
    });
  }),
);

it.effect.each([
  { action: "tools.list", family: "tools" },
  { action: "resources.list", family: "resources" },
  { action: "resources.templates", family: "templates" },
  { action: "prompts.list", family: "prompts" },
] as const)(
  "settles $family independently and clears its diagnostic after recovery",
  ({ action, family }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        { a: server("a") },
        { tools: true, resources: true, prompts: true },
      );
      yield* Ref.set(harness.route, (request, id) =>
        request.action === action
          ? Effect.fail(
              boundaryError("unsupported", "completed", "private-error", "rpc-method-not-found"),
            )
          : defaultRoute(request, id),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const first = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(first.support[family]).toBe(false);
        expect(first[family]).toEqual([]);
        expect(first.diagnostics).toEqual([{ family, reason: "rpc-method-not-found" }]);
        for (const other of ["tools", "resources", "templates", "prompts"] as const)
          if (other !== family) expect(first[other].length).toBeGreaterThan(0);
        const oldPage = yield* discovery.cached({
          family: family === "tools" ? "resources" : "tools",
          limit: 1,
        });
        const oldRef = oldPage.entries[0]!.ref;
        yield* Ref.set(harness.route, defaultRoute);
        const restored = yield* connections.withOperation("a", {}, discovery.refresh);
        expect(restored.support[family]).toBe(true);
        expect(restored.diagnostics).toEqual([]);
        expect(restored.revision).toBeGreaterThan(first.revision);
        expect(yield* discovery.cachedDetail(oldRef).pipe(Effect.flip)).toMatchObject({
          kind: "stale",
        });
        expect((yield* discovery.cached({ family })).catalogs[0]).toMatchObject({ state: "ready" });
        yield* connections.disconnect("a");
        expect(yield* discovery.known).toEqual([]);
        expect((yield* discovery.cached({ family })).catalogs[0]?.reason).toBeUndefined();
      });
    }),
);

it.effect.each([
  boundaryError("auth-required", "completed", "rejected credentials"),
  boundaryError("timeout", "unknown", "expired"),
  boundaryError("unsupported", "unknown", "uncertain", "rpc-method-not-found"),
  boundaryError("unsupported", "completed", "different interaction"),
  boundaryError("protocol", "completed", "malformed result"),
  boundaryError("cleanup", "unknown", "unconfirmed"),
])("does not publish successful sibling catalogs after a fatal family failure", (failure) =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(
      { a: server("a") },
      { tools: true, resources: true, prompts: true },
    );
    yield* Ref.set(harness.route, (request, id) =>
      request.action === "resources.list" ? Effect.fail(failure) : defaultRoute(request, id),
    );
    yield* harness.run(function* ({ discovery }) {
      expect(
        yield* discovery.query({ action: "tools.list", server: "a" }).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(yield* discovery.known).toEqual([]);
      expect((yield* discovery.cached({ family: "tools" })).entries).toEqual([]);
    });
  }),
);

it.effect("refresh failure preserves the previous complete metadata revision", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness(undefined, { tools: true, resources: true, prompts: true });
    yield* harness.run(function* ({ discovery, connections }) {
      const before = yield* connections.withOperation("a", {}, discovery.ensure);
      yield* connections.withOperation("b", {}, discovery.ensure);
      const queries: ReadonlyArray<McpDiscoveryRequest> = [
        { action: "tools.list" },
        { action: "tools.list", server: "a", limit: 1 },
        { action: "tools.search", query: "no-match" },
        { action: "tools.search", server: "a", query: "alpha" },
        { action: "tools.describe", server: "a", tool: "alpha" },
        { action: "resources.list", server: "a" },
        { action: "resources.templates", server: "a" },
        { action: "prompts.list", server: "a" },
      ];
      yield* Ref.set(harness.route, (request, id) =>
        request.action === "prompts.list"
          ? Effect.fail(boundaryError("transport", "not-sent", "private-refresh-error"))
          : request.action === "tools.list"
            ? Effect.succeed(reply(request, { tools: [tool("changed")] }))
            : defaultRoute(request, id),
      );
      expect(
        yield* Effect.result(connections.withOperation("a", {}, discovery.refresh)),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        yield* connections.withOperation("a", {}, discovery.ensure).pipe(Effect.result),
      ).toMatchObject({ _tag: "Failure" });
      expect(
        (yield* discovery.cached({ family: "tools", server: "a" })).entries.map(
          (item) => item.name,
        ),
      ).not.toContain("changed");
      const callsBefore = yield* Ref.get(harness.calls);
      for (const query of queries.filter((query) => query.server === undefined)) {
        const result = yield* discovery.query(query);
        expect(result.notices.some((notice) => notice.includes("refresh"))).toBe(true);
        expect(result.notices[0]).toContain("a");
        expect(result.notices.join("\n")).not.toContain("private-refresh-error");
      }
      expect((yield* discovery.query({ action: "tools.list", server: "b" })).notices).toEqual([]);
      expect(yield* Ref.get(harness.calls)).toEqual(callsBefore);
      yield* Ref.set(harness.route, defaultRoute);
      const recovered = yield* connections.withOperation("a", {}, discovery.refresh);
      expect(recovered.revision).toBeGreaterThan(before.revision);
      for (const query of queries)
        expect((yield* discovery.query(query)).notices.join(" ")).not.toContain("refresh");
    });
  }),
);

it.effect(
  "aggregate cursors bind every known revision, the query, and configuration revision",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.run(function* ({ discovery, connections }) {
        yield* discovery.query({ action: "tools.list", server: "a" });
        yield* discovery.query({ action: "tools.list", server: "b" });
        const first = yield* queryPage(discovery, { action: "tools.list", limit: 1 });
        const cursor = first.page.nextCursor;
        expect(cursor).toBeDefined();
        if (cursor === undefined) return;
        const second = yield* queryPage(discovery, { action: "tools.list", cursor, limit: 1 });
        expect(second.page.items).not.toEqual(first.page.items);
        expect(
          yield* Effect.result(discovery.query({ action: "tools.search", query: "", cursor })),
        ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        yield* connections.withOperation("b", {}, discovery.refresh);
        expect(
          yield* Effect.result(discovery.query({ action: "tools.list", cursor })),
        ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        const current = yield* queryPage(discovery, { action: "tools.list", limit: 1 });
        yield* harness.update((config) => ({ ...config, revision: 2 }));
        if (current.page.nextCursor !== undefined)
          expect(
            yield* Effect.result(
              discovery.query({ action: "tools.list", cursor: current.page.nextCursor }),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
        expect(yield* discovery.known).toEqual([]);
      });
    }),
);

it.effect(
  "cancelling the first waiter does not cancel a shared metadata owner or its second waiter",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const held = yield* gate();
      yield* Ref.set(harness.route, (request, id) =>
        held.pass.pipe(Effect.andThen(defaultRoute(request, id))),
      );
      yield* harness.run(function* ({ discovery }) {
        const first = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        yield* held.entered;
        const second = yield* Effect.forkScoped(
          discovery.query({ action: "tools.list", server: "a" }),
        );
        yield* Fiber.interrupt(first);
        yield* held.open;
        const result = yield* Fiber.join(second).pipe(Effect.flatMap(decodePage));
        expect(result.page.total).toBe(3);
        expect(yield* Ref.get(harness.calls)).toHaveLength(1);
      });
    }),
);

it.effect(
  "list changes coalesce under one connection-owned consumer after the discovery caller closes",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const refreshed = yield* Deferred.make<void>();
      yield* harness.run(function* ({ discovery }) {
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
        const found = yield* queryPage(discovery, { action: "tools.list", server: "a" });
        expect(found.page.items).toEqual([expect.objectContaining({ name: "changed" })]);
        expect(yield* Ref.get(harness.calls)).toHaveLength(2);
      });
    }),
);

const notificationProbe = Effect.gen(function* () {
  const discovery = yield* McpDiscovery;
  const connections = yield* McpConnections;
  let entered = 0;
  let settled = 0;
  let changed = false;
  yield* connections.withOperation("a", {}, (operation) =>
    discovery.ensure({
      ...operation,
      shared: (key, use) =>
        Effect.suspend(() => {
          entered++;
          return operation
            .shared(key, use)
            .pipe(Effect.ensuring(Effect.sync(() => void settled++)));
        }),
    }),
  );
  yield* discovery.subscribeChanges(() => {
    changed = true;
  });
  return {
    joined: yieldUntil(() => changed).pipe(
      Effect.andThen(TestClock.adjust("30 millis")),
      Effect.andThen(yieldUntil(() => entered >= 2)),
    ),
    settled: (count: number) => yieldUntil(() => settled >= count),
  };
});

it.effect.each([
  { phase: "response", ttlMs: 60_000 },
  { phase: "settlement", ttlMs: 60_000 },
  { phase: "response", ttlMs: 0 },
  { phase: "settlement", ttlMs: 0 },
])(
  "a notification during held $phase publishes passive metadata with TTL $ttlMs",
  ({ phase, ttlMs }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      const held = yield* gate();
      const refreshed = yield* Deferred.make<void>();
      yield* harness.run(function* ({ discovery, connections }) {
        const probe = yield* notificationProbe;
        yield* Ref.set(harness.route, (request) =>
          (phase === "response" ? held.pass : Effect.void).pipe(
            Effect.as(reply(request, { tools: [tool("superseded")] })),
          ),
        );
        const foreground = yield* connections
          .withOperation("a", {}, (operation) =>
            discovery.refresh({
              ...operation,
              shared: (key, use) =>
                operation.shared(key, (owned) =>
                  use(owned).pipe(
                    Effect.tap(() => (phase === "settlement" ? held.pass : Effect.void)),
                  ),
                ),
            }),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* held.entered;
        yield* harness.notify("a", "tools");
        yield* probe.joined;
        yield* Ref.set(harness.route, (request) =>
          Deferred.succeed(refreshed, undefined).pipe(
            Effect.as(reply(request, { ttlMs, tools: [tool("changed")] })),
          ),
        );
        yield* held.open;
        yield* Fiber.join(foreground);
        yield* probe.settled(3);
        expect(yield* Deferred.isDone(refreshed)).toBe(true);
        const cached = yield* discovery.cached({ family: "tools" });
        expect(cached.catalogs[0]?.state).toBe(ttlMs === 0 ? "stale" : "ready");
        const page = yield* queryPage(discovery, { action: "tools.list" });
        expect(page.page.items).toEqual([expect.objectContaining({ name: "changed" })]);
        yield* TestClock.adjust("100 millis");
        expect(yield* Ref.get(harness.calls)).toHaveLength(3);
      });
    }),
);

/** Holds a foreground refresh, notifies during it, then releases it once `followup` has started. */
const holdRefreshThenNotify = (
  harness: Effect.Success<ReturnType<typeof makeHarness>>,
  followup: Route,
) =>
  Effect.gen(function* () {
    const discovery = yield* McpDiscovery;
    const connections = yield* McpConnections;
    const probe = yield* notificationProbe;
    const held = yield* gate();
    const started = yield* Deferred.make<void>();
    yield* Ref.set(harness.route, (request) =>
      held.pass.pipe(Effect.as(reply(request, { tools: [tool("superseded")] }))),
    );
    const foreground = yield* connections
      .withOperation("a", {}, discovery.refresh)
      .pipe(Effect.result, Effect.forkChild);
    yield* held.entered;
    yield* harness.notify("a", "tools");
    yield* probe.joined;
    yield* Ref.set(harness.route, (request, id) =>
      Deferred.succeed(started, undefined).pipe(Effect.andThen(followup(request, id))),
    );
    yield* held.open;
    yield* Fiber.join(foreground);
    yield* yieldUntil(() => Deferred.isDoneUnsafe(started));
    return { discovery, connections, probe };
  });

it.effect.each(["failure", "deadline", "revocation"] as const)(
  "notification follow-up stays bounded after %s",
  (outcome) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      yield* harness.run(function* () {
        const { discovery, connections, probe } = yield* holdRefreshThenNotify(harness, () =>
          outcome === "failure"
            ? Effect.fail(boundaryError("transport", "unknown", "Fixture refresh failed."))
            : Effect.never,
        );
        if (outcome === "revocation") yield* connections.revoke("a");
        yield* TestClock.adjust("61 seconds");
        yield* probe.settled(3);
        expect(yield* Ref.get(harness.calls)).toHaveLength(3);
        const cached = yield* discovery.cached({ family: "tools" });
        if (outcome === "revocation") {
          expect(cached.entries).toEqual([]);
          expect(yield* discovery.known).toEqual([]);
        } else {
          expect(cached.catalogs[0]?.state).toBe("refresh-failed");
          const page = yield* queryPage(discovery, { action: "tools.list" });
          expect(page.page.items).toHaveLength(3);
        }
      });
    }),
);

it.effect("notifications arriving during the bounded follow-up remain pending", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ a: server("a") });
    const finish = yield* Deferred.make<void>();
    yield* harness.run(function* () {
      const { discovery, probe } = yield* holdRefreshThenNotify(harness, (request) =>
        Deferred.await(finish).pipe(
          Effect.as(reply(request, { tools: [tool("also-superseded")] })),
        ),
      );
      let arrivals = 0;
      yield* discovery.subscribeChanges(() => {
        arrivals++;
      });
      yield* harness.notify("a", "tools");
      yield* yieldUntil(() => arrivals > 0);
      yield* TestClock.adjust("30 millis");
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed(reply(request, { tools: [tool("latest")] })),
      );
      yield* Deferred.succeed(finish, undefined);
      yield* probe.settled(3);
      yield* TestClock.adjust("30 millis");
      yield* probe.settled(4);
      expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe("ready");
      const page = yield* queryPage(discovery, { action: "tools.list" });
      expect(page.page.items).toEqual([expect.objectContaining({ name: "latest" })]);
      expect(yield* Ref.get(harness.calls)).toHaveLength(4);
    });
  }),
);

it.effect("a notification-owned failed refresh is not retried", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ a: server("a") });
    yield* harness.run(function* ({ discovery }) {
      const probe = yield* notificationProbe;
      yield* Ref.set(harness.route, () =>
        Effect.fail(boundaryError("transport", "unknown", "Fixture refresh failed.")),
      );
      yield* harness.notify("a", "tools");
      yield* probe.joined;
      yield* probe.settled(2);
      yield* TestClock.adjust("100 millis");
      expect(yield* Ref.get(harness.calls)).toHaveLength(2);
      expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe(
        "refresh-failed",
      );
    });
  }),
);

it.effect(
  "revocation removes known metadata and blocks an in-flight refresh from republishing",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const started = yield* Deferred.make<void>();
      yield* harness.run(function* ({ discovery, connections }) {
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
        const known = yield* queryPage(discovery, { action: "tools.list" });
        expect(known.page.items).toEqual([]);
      });
    }),
);

it.effect("an expired notification owner cannot be repopulated by a late refresh", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const held = yield* gate();
    yield* harness.run(function* ({ discovery, connections }) {
      yield* discovery.query({ action: "tools.list", server: "a" });
      yield* Ref.set(harness.route, (request, id) =>
        held.pass.pipe(Effect.andThen(defaultRoute(request, id))),
      );
      const pending = yield* Effect.forkScoped(
        connections.withOperation("a", {}, discovery.refresh),
      );
      yield* held.entered;
      yield* harness.endChanges("a");
      yield* TestClock.adjust("30 millis");
      expect(yield* discovery.known).toEqual([]);
      yield* held.open;
      expect((yield* Fiber.join(pending).pipe(Effect.flip)).kind).toBe("stale");
      expect(yield* discovery.known).toEqual([]);
    });
  }),
);

it.effect("targeted queries reuse an existing admission and reject a mismatched operation", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    yield* harness.run(function* ({ discovery, connections }) {
      const result = yield* connections.withOperation("a", {}, (operation) =>
        discovery.query({ action: "tools.describe", server: "a", tool: "alpha" }, operation),
      );
      expect(result.data).toMatchObject({ name: "alpha" });
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
    });
  }),
);

it.effect("ranks full metadata globally before paging and agrees with cached search", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({
      a: server("a", { denyTools: ["read file"] }),
      b: server("b"),
      unknown: server("unknown"),
    });
    const catalog = [
      { name: "description", description: "x".repeat(520) + "\n\nread any file" },
      { name: "title", title: "Read a file" },
      { name: "read_file", description: "Instructions.\n\nMore instructions." },
      { name: "readFile" },
      { name: "read file" },
    ].map((metadata) => ({ ...metadata, inputSchema: { type: "object" }, extension: "omitted" }));
    yield* Ref.set(harness.route, (request, id) =>
      request.action === "tools.list"
        ? Effect.succeed(reply(request, { tools: id === "a" ? catalog : [...catalog].reverse() }))
        : defaultRoute(request, id),
    );
    yield* harness.run(function* ({ discovery, connections }) {
      yield* discovery.query({ action: "tools.list", server: "b" });
      const listing = yield* queryPage(discovery, { action: "tools.list", server: "a" });
      const Identity = Schema.Struct({ server: Schema.String, name: Schema.String });
      const identities = (items: ReadonlyArray<Schema.Json>) =>
        Schema.decodeUnknownSync(Schema.Array(Identity))(items).map(
          ({ server, name }) => `${server}/${name}`,
        );
      expect(identities(listing.page.items)).toEqual([
        "a/description",
        "a/readFile",
        "a/read_file",
        "a/title",
      ]);
      const expected = [
        "b/read file",
        "a/readFile",
        "a/read_file",
        "b/readFile",
        "b/read_file",
        "a/title",
        "b/title",
        "a/description",
        "b/description",
      ];
      const found: string[] = [];
      let cursor: string | undefined;
      do {
        const input = { action: "tools.search" as const, query: "read file", limit: 2 };
        const request = cursor === undefined ? input : { ...input, cursor };
        const page = yield* queryPage(discovery, request);
        expect(page.page.total).toBe(expected.length);
        expect(page.undiscovered).toEqual(["unknown"]);
        for (const item of page.page.items) {
          expect(item).not.toHaveProperty("inputSchema");
          expect(item).not.toHaveProperty("extension");
        }
        found.push(...identities(page.page.items));
        cursor = page.page.nextCursor;
      } while (cursor !== undefined);
      expect(found).toEqual(expected);
      const cached = yield* discovery.cached({ family: "tools", query: "read file" });
      expect(cached.entries.map(({ ref }) => `${ref.server}/${ref.id}`)).toEqual(expected);
      expect(yield* Ref.get(harness.opened)).toEqual(["b", "a"]);
      const first = yield* queryPage(discovery, {
        action: "tools.search",
        query: "readFile",
        limit: 1,
      });
      const token = first.page.nextCursor!;
      expect(
        yield* discovery
          .query({ action: "tools.search", query: "readfile", cursor: token })
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
      yield* connections.withOperation("b", {}, discovery.refresh);
      expect(
        yield* discovery
          .query({ action: "tools.search", query: "readFile", cursor: token })
          .pipe(Effect.flip),
      ).toMatchObject({ kind: "stale" });
    });
  }),
);

it.effect("keeps an empty metadata search distinct from unsupported dispatcher operations", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ a: server("a") });
    yield* harness.run(function* ({ discovery }) {
      const missing = yield* discovery.query({
        action: "tools.search",
        server: "a",
        query: "attachment",
      });
      expect((yield* decodePage(missing)).page.total).toBe(0);
      expect(missing.notices.join(" ")).toContain("tools.describe");
      expect(missing.notices.join(" ")).toContain("dispatcher");
      expect(missing.notices.join(" ")).toContain("Do not automatically execute");
      const found = yield* discovery.query({
        action: "tools.search",
        server: "a",
        query: "alpha",
      });
      expect((yield* decodePage(found)).page.total).toBe(1);
      expect(found.notices.join(" ")).not.toContain("dispatcher");
    });
  }),
);

it.effect.each([undefined, -1, 0, 1e100])(
  "TTL %s serves one acquisition but is never a later cache hit",
  (ttlMs) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed({
          action: request.action,
          outcome: "completed",
          result:
            ttlMs === undefined
              ? { tools: [tool("first"), tool("second")] }
              : { ttlMs, tools: [tool("first"), tool("second")] },
        }),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const first = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(first.tools).toHaveLength(2);
        expect(first.cacheScope).toBe("private");
        const passive = yield* discovery.query({ action: "tools.list", limit: 1 });
        const old = yield* decodePage(passive);
        expect(passive.notices).toHaveLength(1);
        expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe("stale");
        expect(yield* Ref.get(harness.calls)).toHaveLength(1);
        const next = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(next.revision).toBeGreaterThan(first.revision);
        expect(yield* Ref.get(harness.calls)).toHaveLength(2);
        expect(
          yield* discovery
            .query({ action: "tools.list", cursor: old.page.nextCursor! })
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "stale" });
      });
    }),
);

it.effect(
  "expiry is access-driven; passive reads stay local and failed refresh cannot authorize calls",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed(
          reply(request, {
            ttlMs: 100,
            tools: [tool("old")],
            cacheScope: "public",
          }),
        ),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const first = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(first.cacheScope).toBe("public");
        yield* TestClock.adjust("99 millis");
        expect(yield* connections.withOperation("a", {}, discovery.ensure)).toBe(first);
        yield* TestClock.adjust("1 millis");
        expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe("stale");
        const passive = yield* discovery.query({ action: "tools.list" });
        expect(passive.notices).toHaveLength(1);
        expect((yield* decodePage(passive)).page.items).toHaveLength(1);
        expect(yield* Ref.get(harness.calls)).toHaveLength(1);
        yield* Ref.set(harness.route, () =>
          Effect.fail(boundaryError("transport", "not-sent", "secret")),
        );
        expect(
          yield* connections.withOperation("a", {}, discovery.ensure).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure" });
        expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe(
          "refresh-failed",
        );
        expect((yield* discovery.query({ action: "tools.list" })).notices.join(" ")).not.toContain(
          "secret",
        );
        expect(yield* Ref.get(harness.calls)).toHaveLength(2);
        yield* Ref.set(harness.route, defaultRoute);
        expect(
          (yield* connections.withOperation("a", {}, discovery.ensure)).revision,
        ).toBeGreaterThan(first.revision);
      });
    }),
);

it.effect(
  "short first-page TTL governs the whole catalog even when later pages arrive after expiry",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      const last = yield* gate();
      yield* Ref.set(harness.route, (request) =>
        request.action === "tools.list" && request.cursor === undefined
          ? Effect.succeed(
              reply(request, {
                tools: [tool("first")],
                ttlMs: 10,
                cacheScope: "public",
                nextCursor: "last",
              }),
            )
          : last.pass.pipe(
              Effect.as(
                reply(request, { tools: [tool("last")], ttlMs: 60_000, cacheScope: "private" }),
              ),
            ),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const collecting = yield* connections
          .withOperation("a", {}, discovery.ensure)
          .pipe(Effect.forkChild);
        yield* last.entered;
        yield* TestClock.adjust("11 millis");
        yield* last.open;
        const first = yield* Fiber.join(collecting);
        expect(first.tools).toHaveLength(2);
        expect(first.cacheScope).toBe("private");
        expect((yield* discovery.cached({ family: "tools" })).catalogs[0]?.state).toBe("stale");
        yield* Ref.set(harness.route, defaultRoute);
        expect(
          (yield* connections.withOperation("a", {}, discovery.ensure)).revision,
        ).toBeGreaterThan(first.revision);
      });
    }),
);

it.effect("expired ensure joins an existing metadata refresh, including a zero-TTL result", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness({ a: server("a") });
    const held = yield* gate();
    yield* harness.run(function* ({ discovery, connections }) {
      yield* connections.withOperation("a", {}, discovery.ensure);
      yield* TestClock.adjust("60 seconds");
      yield* Ref.set(harness.route, (request) =>
        held.pass.pipe(Effect.as(reply(request, { ttlMs: 0, tools: [tool("new")] }))),
      );
      const refresh = yield* connections
        .withOperation("a", {}, discovery.refresh)
        .pipe(Effect.forkChild);
      yield* held.entered;
      const joined = yield* connections
        .withOperation("a", {}, discovery.ensure)
        .pipe(Effect.forkChild);
      // Drain runnable fibers so the ensure waiter has reached shared-refresh admission.
      yield* TestClock.adjust("0 millis");
      yield* held.open;
      expect(yield* Fiber.join(joined)).toBe(yield* Fiber.join(refresh));
      expect(yield* Ref.get(harness.calls)).toHaveLength(2);
    });
  }),
);

it.effect.each(["private", "public"] as const)(
  "never reuses %s metadata across authorization revisions",
  (cacheScope) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      let epoch = 0;
      const authorize = (operation: McpOperation): McpOperation => ({
        ...operation,
        binding: { ...operation.binding, authorizationRevision: epoch },
        shared: (key, use) => operation.shared(key, (owner) => use(authorize(owner))),
      });
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed(reply(request, { cacheScope, tools: [tool("old-user")] })),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const ensure = () =>
          connections.withOperation("a", {}, (operation) => discovery.ensure(authorize(operation)));
        const first = yield* ensure();
        const old = (yield* discovery.cached({ family: "tools" })).entries[0]!.ref;
        epoch++;
        yield* Ref.set(harness.route, () =>
          Effect.fail(boundaryError("transport", "not-sent", "failed")),
        );
        expect(yield* ensure().pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
        expect((yield* discovery.cached({ family: "tools" })).entries).toEqual([]);
        expect(yield* discovery.cachedDetail(old).pipe(Effect.flip)).toMatchObject({
          kind: "stale",
        });
        yield* Ref.set(harness.route, defaultRoute);
        const next = yield* ensure();
        expect(next.authorizationRevision).toBe(1);
        expect(next.revision).toBeGreaterThan(first.revision);
      });
    }),
);

const continuationRequests = [
  { action: "tools.list", server: "a", limit: 1 },
  { action: "tools.search", server: "a", query: "", limit: 1 },
  { action: "resources.list", server: "a", limit: 1 },
  { action: "resources.templates", server: "a", limit: 1 },
  { action: "prompts.list", server: "a", limit: 1 },
] as const;

it.effect.each(
  [undefined, 0, 100].flatMap((ttlMs) =>
    continuationRequests.map((request) => ({ ttlMs, request })),
  ),
)(
  "$request.action continues the captured snapshot after TTL $ttlMs expires",
  ({ ttlMs, request }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(
        { a: server("a") },
        { tools: true, resources: true, prompts: true },
      );
      yield* Ref.set(harness.route, (input) => {
        const names = ["alpha", "beta", "gamma"];
        const result =
          input.action === "tools.list"
            ? { tools: names.map(tool) }
            : input.action === "resources.list"
              ? { resources: names.map((name) => ({ name, uri: `file:///${name}` })) }
              : input.action === "resources.templates"
                ? {
                    resourceTemplates: names.map((name) => ({
                      name,
                      uriTemplate: `file:///${name}/{id}`,
                    })),
                  }
                : { prompts: names.map((name) => ({ name })) };
        return Effect.succeed({
          action: input.action,
          outcome: "completed",
          result: ttlMs === undefined ? result : { ...result, ttlMs },
        });
      });
      yield* harness.run(function* ({ discovery, connections }) {
        const first = yield* queryPage(discovery, request);
        const revision = (yield* discovery.known)[0]!.revision;
        yield* TestClock.adjust("100 millis");
        const calls = yield* Ref.get(harness.calls);
        yield* Ref.set(harness.route, () =>
          Effect.fail(boundaryError("transport", "not-sent", "Fixture refresh failed.")),
        );
        const items = [...first.page.items];
        let cursor = first.page.nextCursor;
        while (cursor !== undefined) {
          const next = yield* discovery.query({ ...request, cursor });
          expect(next.notices).not.toHaveLength(0);
          const page = yield* decodePage(next);
          items.push(...page.page.items);
          cursor = page.page.nextCursor;
        }
        expect(
          items.map(
            (item) => Schema.decodeUnknownSync(Schema.Struct({ name: Schema.String }))(item).name,
          ),
        ).toEqual(["alpha", "beta", "gamma"]);
        expect((yield* discovery.known)[0]!.revision).toBe(revision);
        expect(yield* Ref.get(harness.calls)).toEqual(calls);
        // Snapshot inspection must not make the same revision safe for invocation.
        expect(
          yield* connections.withOperation("a", {}, discovery.ensure).pipe(Effect.flip),
        ).toMatchObject({ kind: "transport", outcome: "not-sent" });
        expect(
          yield* discovery
            .query({ action: "tools.describe", server: "a", tool: "alpha" })
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "transport" });
        expect(yield* discovery.query(request).pipe(Effect.flip)).toMatchObject({
          kind: "transport",
        });
      });
    }),
);

it.effect.each(["refresh", "notification", "auth", "config", "owner"] as const)(
  "%s invalidates targeted continuation cursors without refreshing them",
  (change) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      yield* harness.run(function* ({ discovery, connections }) {
        const input = { action: "tools.list", server: "a", limit: 1 } as const;
        const first = yield* queryPage(discovery, input);
        if (change === "refresh") yield* connections.withOperation("a", {}, discovery.refresh);
        else if (change === "auth") yield* connections.withAuth("a", () => Effect.void);
        else if (change === "config")
          yield* harness.update((config) => ({ ...config, revision: config.revision + 1 }));
        else if (change === "owner") yield* connections.disconnect("a");
        else {
          yield* harness.notify("a", "tools");
          // Deliver the notification but keep the debounce refresh pending.
          yield* TestClock.adjust("0 millis");
        }
        const calls = yield* Ref.get(harness.calls);
        const opened = yield* Ref.get(harness.opened);
        expect(
          yield* discovery.query({ ...input, cursor: first.page.nextCursor! }).pipe(Effect.flip),
        ).toMatchObject({ kind: "stale", outcome: "not-sent" });
        expect(yield* Ref.get(harness.calls)).toEqual(calls);
        expect(yield* Ref.get(harness.opened)).toEqual(opened);
      });
    }),
);

it.effect(
  "continuation inspection needs no admission and checks any supplied operation binding",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ a: server("a") });
      yield* harness.update((config) => ({
        ...config,
        settings: { ...config.settings, maxPerServer: 1 },
      }));
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed(
          reply(request, {
            ttlMs: 0,
            tools: [tool("alpha"), tool("beta"), tool("gamma")],
          }),
        ),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const input = { action: "tools.list", server: "a", limit: 1 } as const;
        const first = yield* queryPage(discovery, input);
        const request = { ...input, cursor: first.page.nextCursor! };
        // Hold the server's only ticket. A continuation that reacquires admission cannot settle.
        yield* connections.withOperation("a", {}, (operation) =>
          Effect.gen(function* () {
            const local = yield* queryPage(discovery, request);
            const admitted = yield* queryPage(discovery, request, operation);
            expect(local.page.items).toEqual([expect.objectContaining({ name: "beta" })]);
            expect(admitted.page.items).toEqual(local.page.items);
            expect(
              yield* discovery
                .query(request, {
                  ...operation,
                  binding: {
                    ...operation.binding,
                    authorizationRevision: operation.binding.authorizationRevision + 1,
                  },
                })
                .pipe(Effect.flip),
            ).toMatchObject({ kind: "stale" });
          }).pipe(Effect.orDie),
        );
        expect(yield* Ref.get(harness.calls)).toHaveLength(1);
      });
    }),
);

it.effect.each([true, false])(
  "filters invalid parameter-header definitions consistently only for modern HTTP=%s",
  (modern) =>
    Effect.gen(function* () {
      const capabilities = { tools: true, resources: false, prompts: false };
      const validNames = ["valid", "literal-const", "literal-default", "literal-examples"];
      const harness = yield* makeHarness(
        { a: server("a") },
        modern ? { ...capabilities, parameterHeaders: true } : capabilities,
      );
      yield* Ref.set(harness.route, (request) =>
        Effect.succeed(
          reply(request, {
            tools: [
              tool("valid"),
              ...["const", "default", "examples"].map((keyword) => ({
                name: `literal-${keyword}`,
                inputSchema: {
                  type: "object",
                  properties: {
                    payload: {
                      type: "object",
                      [keyword]:
                        keyword === "examples"
                          ? [{ "x-mcp-header": "literal data" }]
                          : { "x-mcp-header": "literal data" },
                    },
                  },
                },
              })),
              {
                name: "invalid",
                inputSchema: { properties: { value: { type: "number", "x-mcp-header": "Value" } } },
              },
            ],
          }),
        ),
      );
      yield* harness.run(function* ({ discovery, connections }) {
        const snapshot = yield* connections.withOperation("a", {}, discovery.ensure);
        expect(snapshot.tools.map((entry) => entry.name)).toEqual(
          modern ? validNames : [...validNames, "invalid"],
        );
        const listed = yield* queryPage(discovery, { action: "tools.list", server: "a" });
        expect(listed.page.total).toBe(validNames.length + (modern ? 0 : 1));
        const found = yield* queryPage(discovery, { action: "tools.search", query: "invalid" });
        expect(found.page.total).toBe(modern ? 0 : 1);
        const exact = yield* discovery
          .query({ action: "tools.describe", server: "a", tool: "invalid" })
          .pipe(Effect.result);
        expect(exact._tag).toBe(modern ? "Failure" : "Success");
        expect((yield* discovery.cached({ family: "tools" })).total).toBe(
          validNames.length + (modern ? 0 : 1),
        );
      });
    }),
);
