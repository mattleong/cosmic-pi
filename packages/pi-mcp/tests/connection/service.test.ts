import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { yieldUntil } from "pi-cosmic-core/testing";
import { HttpServerResponse } from "effect/unstable/http";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import type { McpAuthRejection } from "../../src/auth/model.ts";
import { getAuthChallenge, setAuthChallenge } from "../../src/auth/challenge.ts";
import { McpConnector, type McpConnectorContract } from "../../src/boundary/sdk-connection.ts";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { boundaryError, type McpBoundaryError } from "../../src/client/errors.ts";
import type { McpConnection, McpReply, McpRequest } from "../../src/client/model.ts";
import type {
  McpResolvedConfig,
  McpServerDefinition,
  McpSettings,
} from "../../src/config/model.ts";
import type {
  McpConnectionStatus,
  McpConnectionsContract,
  McpOperation,
} from "../../src/connection/model.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { startHttpServer } from "../fixtures/http-server.ts";
import { gate } from "../fixtures/probes.ts";
import {
  fakeAuth,
  fakeConfigStore,
  fakeConnection,
  httpDefinition,
  runWith,
  stdioDefinition,
  testConfig,
  testServer,
  testSettings,
} from "../fixtures/services.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const server = (
  id: string,
  definition: McpServerDefinition = stdioDefinition({
    command: "private-executable",
    denyTools: ["denied"],
  }),
) => testServer(id, { identity: `${id}-1`, directory: "/private/secret-path", definition });
const initialConfig = (settings?: Partial<McpSettings>): McpResolvedConfig =>
  testConfig({ settings, servers: { a: server("a"), b: server("b") } });
const httpConfig = (http: Parameters<typeof httpDefinition>[0], settings?: Partial<McpSettings>) =>
  testConfig({ settings, servers: { a: server("a", httpDefinition(http)) } });
interface FixtureOptions {
  readonly settings?: Partial<McpSettings>;
  readonly config?: McpResolvedConfig;
  readonly open?: McpConnectorContract["open"];
  readonly opening?: Effect.Effect<void, McpBoundaryError>;
  readonly closing?: Effect.Effect<void>;
  readonly uncertain?: boolean;
  readonly scopeCleanup?: boolean;
  readonly terminalBeforeReply?: boolean;
  readonly auth?: Effect.Effect<string | undefined, McpBoundaryError>;
  readonly request?: (input: McpRequest) => Effect.Effect<McpReply, McpBoundaryError>;
  readonly subscribeResource?: McpConnection["subscribeResource"];
}
const fixture = (options: FixtureOptions = {}) => {
  const tokens: Array<string | undefined> = [];
  let observedAuth: "none" | "required" = "none";
  const rejections: Array<McpAuthRejection | undefined> = [];
  const state = {
    trusted: true,
    opens: 0,
    closes: 0,
    accesses: 0,
    requests: 0,
    tokens,
    rejections,
  };
  const store = fakeConfigStore(options.config ?? initialConfig(options.settings), {
    reload: Effect.suspend(() =>
      store.publish({ ...store.current(), revision: store.current().revision + 1 }),
    ),
  });
  const dependencies = Layer.mergeAll(
    McpActivity.layer(),
    store.layer,
    Layer.succeed(
      McpAuth,
      fakeAuth({
        access: () =>
          Effect.gen(function* () {
            state.accesses += 1;
            return yield* options.auth ?? Effect.succeed(undefined);
          }),
        status: () => Effect.succeed({ state: observedAuth }),
        reject: (_server, evidence) =>
          Effect.sync(() => {
            rejections.push(evidence);
            observedAuth = "required";
          }),
      }),
    ),
    Layer.succeed(McpConnector, {
      open: (server, settings, token, onCleanup) =>
        Effect.gen(function* () {
          state.opens += 1;
          yield* options.opening ?? Effect.void;
          if (options.open) return yield* options.open(server, settings, token, onCleanup);
          if (options.scopeCleanup !== undefined)
            yield* Effect.addFinalizer(() => Effect.sync(() => onCleanup?.(options.scopeCleanup!)));
          let closed = false;
          return yield* fakeConnection((terminal) => ({
            capabilities: {
              tools: true,
              resources: true,
              prompts: true,
              resourceSubscriptions: options.subscribeResource !== undefined,
            },
            ...(options.subscribeResource && { subscribeResource: options.subscribeResource }),
            health: Effect.sync(() => ({ closed, cleanupUnconfirmed: options.uncertain === true })),
            close: Effect.uninterruptible(
              Effect.gen(function* () {
                if (!closed) {
                  yield* options.closing ?? Effect.void;
                  closed = true;
                  state.closes += 1;
                  yield* Deferred.succeed(terminal, undefined);
                }
                if (options.uncertain)
                  return yield* boundaryError("cleanup", "unknown", "MCP cleanup is unconfirmed.");
              }),
            ),
            setToken: (token) =>
              Effect.sync(() => {
                state.tokens.push(token);
              }),
            request: (input) =>
              Effect.gen(function* () {
                state.requests += 1;
                if (options.terminalBeforeReply) {
                  if (options.uncertain)
                    yield* Deferred.fail(
                      terminal,
                      boundaryError("cleanup", "unknown", "MCP cleanup is unconfirmed."),
                    );
                  else yield* Deferred.succeed(terminal, undefined);
                  yield* Effect.yieldNow;
                }
                return yield* (
                  options.request?.(input) ??
                    Effect.succeed<McpReply>({
                      action: input.action,
                      outcome: "completed",
                      result: { ok: true },
                      ...(options.uncertain && { cleanupUnconfirmed: true }),
                    })
                );
              }),
          }));
        }),
    }),
  );
  const layer = McpConnections.layer({ isTrusted: () => state.trusted }).pipe(
    Layer.provide(dependencies),
  );
  return {
    state,
    config: store.current,
    replace: store.publish,
    run: runWith(Effect.service(McpConnections), layer),
  };
};
const call = (connections: McpConnectionsContract, server = "a") =>
  connections.withOperation(server, { tool: "write" }, (op) =>
    op.request({ action: "tools.call", tool: "write" }),
  );
const subscribe = (connections: McpConnectionsContract) =>
  connections.withOperation("a", {}, (op) => op.subscribeResource("test://one"));
const awaitStatus = (
  connections: McpConnectionsContract,
  predicate: (status: McpConnectionStatus) => boolean,
) =>
  Effect.gen(function* () {
    for (let n = 0; n < 1_000; n += 1) {
      if (predicate(yield* connections.status)) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die("MCP connection status did not settle.");
  });

it.effect(
  "carries admitted HTTP auth recovery through acquisition and discovery failures without replay",
  () =>
    Effect.gen(function* () {
      for (const auth of [
        { type: "none" as const },
        { type: "env" as const, env: "PRIVATE_ENV" },
        { type: "oauth" as const, registration: "dynamic" as const, scopes: [] },
      ]) {
        const configured = httpConfig({ headers: { Authorization: "private-header" }, auth });
        for (const phase of ["access", "open", "request"] as const) {
          const outcome = phase === "access" ? "not-sent" : "unknown";
          const rejected = Effect.fail(boundaryError("auth-required", outcome, "private-error"));
          const f = fixture({
            config: configured,
            ...(phase === "access"
              ? { auth: rejected }
              : phase === "open"
                ? { opening: rejected }
                : { request: () => rejected }),
          });
          yield* f.run(function* (c) {
            const error = yield* c
              .withOperation("a", {}, (op) => op.request({ action: "tools.list" }))
              .pipe(Effect.flip);
            expect(error).toMatchObject({
              kind: "auth-required",
              outcome,
              reason:
                auth.type === "none"
                  ? "auth-not-configured"
                  : auth.type === "env"
                    ? "auth-env-required"
                    : "auth-oauth-required",
            });
            expect(f.state.requests).toBe(phase === "request" ? 1 : 0);
            expect(f.state.opens).toBe(phase === "access" ? 0 : 1);
            expect(f.state.rejections).toHaveLength(phase === "access" ? 0 : 1);
            expect(f.config()).toBe(configured);
          });
        }
      }
    }),
);

it.effect.each([
  {
    name: "auth rejection",
    reply: Effect.fail(boundaryError("auth-required", "not-sent", "rejected")),
    tag: "Failure",
    auth: "required",
  },
  {
    name: "tool error result",
    reply: Effect.succeed<McpReply>({
      action: "tools.call",
      outcome: "completed",
      result: { isError: true, content: [{ type: "text", text: "permission denied" }] },
    }),
    tag: "Success",
    auth: "none",
  },
  {
    name: "policy denial",
    reply: Effect.fail(boundaryError("denied", "unknown", "HTTP policy denial")),
    tag: "Failure",
    auth: "none",
  },
])(
  "only current-owner auth-specific rejection changes auth evidence: $name",
  ({ reply, tag, auth }) =>
    Effect.gen(function* () {
      const f = fixture({ request: () => reply });
      yield* f.run(function* (c) {
        expect((yield* Effect.result(call(c)))._tag).toBe(tag);
        expect((yield* c.status).servers[0]?.auth).toBe(auth);
      });
    }),
);

it.effect("an auth rejection arriving after lost trust cannot publish new auth evidence", () =>
  Effect.gen(function* () {
    const held = yield* gate();
    const f = fixture({
      request: () =>
        held.pass.pipe(
          Effect.andThen(Effect.fail(boundaryError("auth-required", "not-sent", "rejected"))),
        ),
    });
    yield* f.run(function* (c) {
      const pending = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* held.entered;
      f.state.trusted = false;
      yield* held.open;
      yield* Fiber.join(pending);
      f.state.trusted = true;
      expect((yield* c.status).servers[0]?.auth).toBe("none");
    });
  }),
);

for (const phase of ["open", "request", "subscribe"] as const)
  for (const token of [undefined, "private-token"])
    it.effect(
      `passes original ${phase} rejection evidence with credential use ${token !== undefined}`,
      () =>
        Effect.gen(function* () {
          const challenge = {
            status: 403 as const,
            wwwAuthenticate: 'Bearer scope="private-scope"',
          };
          const original = setAuthChallenge(
            boundaryError("auth-required", "unknown", "Rejected."),
            challenge,
          );
          const f = fixture({
            auth: Effect.succeed(token),
            ...(phase === "open"
              ? { opening: Effect.fail(original) }
              : phase === "request"
                ? { request: () => Effect.fail(original) }
                : { subscribeResource: () => Effect.fail(original) }),
          });
          yield* f.run(function* (c) {
            const error = yield* (phase === "subscribe" ? subscribe(c) : call(c)).pipe(Effect.flip);
            expect(error.outcome).toBe("unknown");
            expect(f.state.rejections).toHaveLength(1);
            expect(f.state.rejections[0]?.credentialUsed).toBe(token !== undefined);
            expect(f.state.rejections[0]?.error).toBe(original);
            expect(getAuthChallenge(f.state.rejections[0]!.error!)).toEqual(challenge);
            expect(f.state.requests).toBe(phase === "request" ? 1 : 0);
          });
        }),
    );

it.effect.each(["request", "subscribe"] as const)(
  "a dispatch-time local credential failure in %s does not reject a server credential",
  (phase) =>
    Effect.gen(function* () {
      let checks = 0;
      let subscriptions = 0;
      const f = fixture({
        auth: Effect.suspend(() =>
          ++checks === 1
            ? Effect.succeed("private-token")
            : Effect.fail(boundaryError("auth-required", "not-sent", "Local grant unavailable.")),
        ),
        subscribeResource: () => {
          subscriptions++;
          return Effect.die("No subscription should be dispatched.");
        },
      });
      yield* f.run(function* (c) {
        expect(
          yield* (phase === "request" ? call(c) : subscribe(c)).pipe(Effect.flip),
        ).toMatchObject({ kind: "auth-required", outcome: "not-sent" });
        expect([f.state.requests, subscriptions]).toEqual([0, 0]);
        expect(f.state.rejections).toHaveLength(0);
        expect((yield* c.status).servers[0]?.auth).toBe("none");
      });
    }),
);

it.effect.each(["request", "subscribe"] as const)(
  "current-owner %s rejection fences queued dispatch and attaches fixed auth guidance",
  (phase) =>
    Effect.gen(function* () {
      const held = yield* gate();
      const original = boundaryError("auth-required", "unknown", "Rejected.");
      const rejected = () => held.pass.pipe(Effect.andThen(Effect.fail(original)));
      const f = fixture({
        config: httpConfig({ auth: { type: "env", env: "PRIVATE_TOKEN" } }, { maxPerServer: 1 }),
        auth: Effect.succeed("private-token"),
        ...(phase === "request" ? { request: rejected } : { subscribeResource: rejected }),
      });
      yield* f.run(function* (c) {
        const first = yield* (phase === "request" ? call(c) : subscribe(c)).pipe(
          Effect.result,
          Effect.forkScoped,
        );
        yield* held.entered;
        const second = yield* call(c).pipe(Effect.result, Effect.forkScoped);
        yield* awaitStatus(c, (status) => status.servers[0]?.queued === 1);
        yield* held.open;
        expect(yield* Fiber.join(first)).toMatchObject({
          _tag: "Failure",
          failure: { kind: "auth-required", outcome: "unknown", reason: "auth-env-required" },
        });
        expect(yield* Fiber.join(second)).toMatchObject({
          _tag: "Failure",
          failure: { outcome: "not-sent" },
        });
        expect(f.state.requests).toBe(phase === "request" ? 1 : 0);
        expect(f.state.opens).toBe(1);
        expect(f.state.rejections).toHaveLength(1);
        expect(f.state.rejections[0]?.error).toBe(original);
      });
    }),
);

it.effect.each(["not-sent", "completed", "unknown"] as const)(
  "subscription failure keeps %s certainty for later authority checks",
  (outcome) =>
    Effect.gen(function* () {
      const original = boundaryError("protocol", outcome, "Subscription failed.");
      const f = fixture({ subscribeResource: () => Effect.fail(original) });
      yield* f.run(function* (c) {
        const error = yield* c
          .withOperation("a", {}, (op) =>
            Effect.gen(function* () {
              const failed = yield* op.subscribeResource("test://one").pipe(Effect.result);
              expect(failed._tag).toBe("Failure");
              if (failed._tag === "Failure") expect(failed.failure).toBe(original);
              f.state.trusted = false;
              yield* op.checkCurrent;
            }),
          )
          .pipe(Effect.flip);
        expect(error.outcome).toBe(outcome);
      });
    }),
);

it.effect("status does not connect, resolve credentials, or expose config details", () => {
  const f = fixture();
  return f.run(function* (c) {
    const status = yield* c.status;
    expect(status.servers[0]).toMatchObject({ id: "a", state: "disconnected" });
    expect(serialize(status)).not.toMatch(/secret-path|private-executable/);
    expect(f.state.opens).toBe(0);
    expect(f.state.accesses).toBe(0);
  });
});

it.effect("availability is a synchronous projection without I/O or authority mutation", () =>
  Effect.gen(function* () {
    const f = fixture();
    let available: () => boolean = () => false;
    yield* f.run(function* (c) {
      available = c.isAvailable;
      expect(available()).toBe(true);
      f.state.trusted = false;
      expect(available()).toBe(false);
      f.state.trusted = true;
      expect(available()).toBe(true);
      yield* f.replace({ ...f.config(), revision: 2, trusted: false });
      expect(available()).toBe(false);
      yield* f.replace({
        ...f.config(),
        revision: 3,
        trusted: true,
        settings: testSettings({ enabled: false }),
      });
      expect(available()).toBe(false);
      yield* f.replace({ ...f.config(), revision: 4, settings: testSettings() });
      expect(available()).toBe(true);
      expect(f.state.accesses).toBe(0);
      expect(f.state.opens).toBe(0);
    });
    expect(available()).toBe(false);
  }),
);

it.effect("concurrent connection waiters share an owner and cancellation is local", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const f = fixture({ opening: Deferred.await(opening) });
    yield* f.run(function* (c) {
      const first = yield* Effect.forkScoped(call(c));
      yield* yieldUntil(() => f.state.opens === 1, 1_000);
      const second = yield* Effect.forkScoped(call(c));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      expect(f.state.closes).toBe(0);
      yield* Deferred.succeed(opening, undefined);
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(f.state.opens).toBe(1);
      expect(f.state.requests).toBe(1);
    });
    expect(f.state.closes).toBe(1);
  }),
);

it.effect("queued calls expire from initial admission and never dispatch late", () =>
  Effect.gen(function* () {
    const held = yield* gate();
    const f = fixture({
      settings: { maxConcurrent: 1, maxPerServer: 1, requestTimeoutMs: 100 },
      request: (input) =>
        held.pass.pipe(Effect.as({ action: input.action, outcome: "completed", result: {} })),
    });
    yield* f.run(function* (c) {
      const active = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* held.entered;
      const queued = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(queued)).toMatchObject({
        failure: { kind: "timeout", outcome: "not-sent" },
      });
      expect(yield* Fiber.join(active)).toMatchObject({
        failure: { kind: "timeout", outcome: "unknown" },
      });
      yield* held.open;
      expect(f.state.requests).toBe(1);
      expect(yield* c.status).toMatchObject({ active: 0, queued: 0 });
    });
  }),
);

it.effect("one dispatch slot does not deadlock shared metadata or cancel its peer", () =>
  Effect.gen(function* () {
    const held = yield* gate();
    let owners = 0;
    const f = fixture({ settings: { maxConcurrent: 1, maxPerServer: 1 } });
    yield* f.run(function* (c) {
      const metadata = () =>
        c.withOperation("a", {}, (op) =>
          op.shared("metadata", (owned) =>
            Effect.gen(function* () {
              owners += 1;
              yield* held.pass;
              return yield* owned.request({ action: "tools.list" });
            }),
          ),
        );
      const first = yield* Effect.forkScoped(metadata());
      yield* held.entered;
      const second = yield* Effect.forkScoped(metadata());
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(first);
      yield* held.open;
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(owners).toBe(1);
      expect(f.state.requests).toBe(1);
    });
  }),
);

it.effect(
  "abandoned prerequisites keep their bound until deadline cleanup then release capacity",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const f = fixture({
        settings: { maxConcurrent: 1, maxPerServer: 1, maxQueued: 0, requestTimeoutMs: 50 },
        request: (input) =>
          input.action === "tools.list"
            ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed({ action: input.action, outcome: "completed", result: {} }),
      });
      yield* f.run(function* (c) {
        const caller = yield* c
          .withOperation("a", {}, (op) =>
            op.shared("metadata", (fresh) => fresh.request({ action: "tools.list" })),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(caller);
        expect(yield* c.status).toMatchObject({ active: 1, queued: 0 });
        expect(
          yield* c
            .withOperation("b", {}, (op) => op.shared("another", () => Effect.void))
            .pipe(Effect.flip),
        ).toMatchObject({ kind: "busy", outcome: "not-sent" });
        yield* TestClock.adjust(50);
        expect(yield* c.status).toMatchObject({ active: 0, queued: 0 });
        expect(
          (yield* c.withOperation("a", {}, (op) =>
            op.shared("metadata", (fresh) =>
              fresh.request({ action: "resources.read", uri: "mcp://a/value" }),
            ),
          )).outcome,
        ).toBe("completed");
        expect((yield* call(c)).outcome).toBe("completed");
      });
    }),
);

it.effect("connection notifications can start a fresh shared ticket after their caller ends", () =>
  Effect.gen(function* () {
    const notify = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const f = fixture({ settings: { requestTimeoutMs: 100 } });
    yield* f.run(function* (c) {
      yield* c.withOperation("a", {}, (op) =>
        op.forkOwned(
          Deferred.await(notify).pipe(
            Effect.andThen(
              op.shared("metadata", (fresh) => fresh.request({ action: "tools.list" })),
            ),
            Effect.andThen(Deferred.succeed(done, undefined)),
          ),
        ),
      );
      yield* TestClock.adjust(200);
      yield* Deferred.succeed(notify, undefined);
      yield* Deferred.await(done);
      expect(f.state.requests).toBe(1);
    });
  }),
);

it.effect(
  "active operations prevent idle close and stale timer generations cannot close reuse",
  () =>
    Effect.gen(function* () {
      const held = yield* gate();
      const f = fixture({ settings: { idleTimeoutMs: 100 } });
      yield* f.run(function* (c) {
        yield* c.connect("a");
        yield* TestClock.adjust(50);
        const active = yield* Effect.forkScoped(c.withOperation("a", {}, () => held.pass));
        yield* held.entered;
        yield* TestClock.adjust(100);
        expect(f.state.closes).toBe(0);
        yield* held.open;
        yield* Fiber.join(active);
        yield* TestClock.adjust(99);
        expect(f.state.closes).toBe(0);
        yield* TestClock.adjust(1);
        yield* yieldUntil(() => f.state.closes === 1, 1_000);
        yield* c.connect("a");
        expect(f.state.opens).toBe(2);
      });
      expect(f.state.closes).toBe(2);
    }),
);

it.effect("unrelated config edits revoke accepted-result retention before commit returns", () =>
  Effect.gen(function* () {
    const held = yield* gate();
    const cleanup = yield* gate();
    let resultId: string | undefined;
    const f = fixture({
      closing: cleanup.pass,
    });
    yield* f.run(function* (c) {
      const notices: Array<ReadonlyArray<string>> = [];
      yield* c.subscribeRevocations((ids, reason) =>
        Effect.sync(() => {
          if (reason === "connection") return;
          notices.push(ids);
        }),
      );
      const old = yield* Effect.forkScoped(
        Effect.result(
          c.withOperation("a", { tool: "write" }, (op) =>
            op
              .request({ action: "tools.call", tool: "write" })
              .pipe(
                Effect.andThen(held.pass),
                Effect.andThen(
                  op.commit(Effect.sync(() => void (resultId = "old-revision-result"))),
                ),
              ),
          ),
        ),
      );
      yield* held.entered;
      yield* f.replace({
        ...f.config(),
        revision: 2,
        servers: Object.fromEntries(
          Object.entries(f.config().servers).map(([id, server]) => [
            id,
            id === "b" ? { ...server, identity: "b-2" } : server,
          ]),
        ),
      });
      yield* cleanup.entered;
      expect(notices).toEqual([["a", "b"]]);
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "busy" } });
      yield* held.open;
      expect(yield* Fiber.join(old)).toMatchObject({
        failure: { kind: "stale", outcome: "completed" },
      });
      expect(resultId).toBeUndefined();
      yield* cleanup.open;
      yield* c.disconnect("a");
      yield* c.connect("a");
      expect(f.state.opens).toBe(2);
    });
  }),
);

it.effect("live trust loss revokes connections and output before any new credential lookup", () =>
  Effect.gen(function* () {
    const f = fixture();
    let published = false;
    yield* f.run(function* (c) {
      const result = yield* Effect.result(
        c.withOperation("a", { tool: "write" }, (op) =>
          Effect.gen(function* () {
            yield* op.request({ action: "tools.call", tool: "write" });
            f.state.trusted = false;
            return yield* op.commit(Effect.sync(() => void (published = true)));
          }),
        ),
      );
      expect(result).toMatchObject({ failure: { kind: "stale", outcome: "completed" } });
      const accesses = f.state.accesses;
      expect(yield* Effect.result(call(c))).toMatchObject({ failure: { kind: "denied" } });
      expect(f.state.accesses).toBe(accesses);
      expect(published).toBe(false);
      expect((yield* c.status).trusted).toBe(false);
    });
    expect(f.state.closes).toBe(1);
  }),
);

it.effect("disconnect preserves result authority while explicit revoke notifies it", () => {
  const f = fixture();
  return f.run(function* (c) {
    let revoked = 0;
    yield* c.subscribeRevocations((_ids, reason) =>
      Effect.sync(() => {
        if (reason === "connection") return;
        revoked += 1;
      }),
    );
    yield* call(c);
    expect(yield* c.disconnect("a")).toEqual({ servers: ["a"], cleanup: "confirmed" });
    expect(revoked).toBe(0);
    yield* c.revoke("a");
    expect(revoked).toBe(1);
  });
});

it.effect(
  "unconfirmed cleanup leaves a blocked tombstone instead of starting a replacement",
  () => {
    const f = fixture({ uncertain: true });
    return f.run(function* (c) {
      yield* c.connect("a");
      expect(yield* c.disconnect("a")).toMatchObject({ cleanup: "unconfirmed" });
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "cleanup" } });
      yield* f.replace({ ...f.config(), revision: 2 });
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "cleanup" } });
      expect(f.state.opens).toBe(1);
    });
  },
);

it.effect.each([true, false])(
  "outer acquisition deadline retains observer cleanup evidence: %s",
  (confirmed) =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const observed: boolean[] = [];
      const f = fixture({
        settings: { connectTimeoutMs: 100 },
        auth: Effect.sleep(40).pipe(Effect.as(undefined)),
        open: (_server, settings, _token, onCleanup) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never.pipe(
              Effect.timeoutOrElse({
                duration: settings.connectTimeoutMs,
                orElse: () => Effect.fail(boundaryError("timeout", "not-sent", "Inner deadline.")),
              }),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  observed.push(confirmed);
                  onCleanup?.(confirmed);
                  // Later positive evidence must not erase an earlier failure.
                  onCleanup?.(true);
                }),
              ),
            );
          }),
      });
      yield* f.run(function* (c) {
        const opening = yield* Effect.result(c.connect("a")).pipe(
          Effect.ensuring(Deferred.succeed(settled, undefined)),
          Effect.forkScoped,
        );
        yield* TestClock.adjust(40);
        yield* Deferred.await(started);
        yield* TestClock.adjust(59);
        expect(yield* Deferred.isDone(settled)).toBe(false);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(opening)).toMatchObject({ failure: { kind: "timeout" } });
        expect(observed).toEqual([confirmed]);
        expect(yield* c.disconnect("a")).toMatchObject({
          cleanup: confirmed ? "confirmed" : "unconfirmed",
        });
        expect((yield* c.status).servers.find((server) => server.id === "a")?.state).toBe(
          confirmed ? "disconnected" : "blocked",
        );
        const replacement = yield* Effect.result(c.connect("a")).pipe(Effect.forkScoped);
        if (confirmed) {
          yield* TestClock.adjust(100);
          expect(yield* Fiber.join(replacement)).toMatchObject({ failure: { kind: "timeout" } });
          expect(f.state.opens).toBe(2);
        } else {
          expect(yield* Fiber.join(replacement)).toMatchObject({ failure: { kind: "cleanup" } });
          expect(f.state.opens).toBe(1);
        }
      });
    }),
);

it.effect(
  "successful acquisition retains later scope cleanup failure despite healthy close",
  () => {
    const f = fixture({ scopeCleanup: false });
    return f.run(function* (c) {
      yield* c.connect("a");
      expect(yield* c.disconnect("a")).toMatchObject({ cleanup: "unconfirmed" });
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "cleanup" } });
      expect(f.state.opens).toBe(1);
      expect(f.state.closes).toBe(1);
    });
  },
);

it.effect("failed acquisition cleanup allows a later explicit attempt without replay", () => {
  let attempts = 0;
  const f = fixture({
    opening: Effect.suspend(() =>
      ++attempts === 1
        ? Effect.fail(boundaryError("connection", "not-sent", "MCP startup failed."))
        : Effect.void,
    ),
  });
  return f.run(function* (c) {
    expect(yield* Effect.result(call(c))).toMatchObject({ failure: { kind: "connection" } });
    yield* c.disconnect("a");
    expect((yield* call(c)).outcome).toBe("completed");
    expect(f.state.requests).toBe(1);
    expect(f.state.opens).toBe(2);
  });
});

it.effect(
  "retains observation failure after retirement and clears it on fresh acquisition or config change",
  () => {
    const failures: Effect.Effect<void>[] = [];
    const f = fixture({
      open: () =>
        fakeConnection((terminal) => {
          let failed = false;
          failures.push(
            Effect.sync(() => {
              failed = true;
            }).pipe(
              Effect.andThen(
                Deferred.fail(
                  terminal,
                  boundaryError("transport", "unknown", "Metadata observation failed."),
                ),
              ),
              Effect.asVoid,
            ),
          );
          return {
            protocolVersion: "2026-07-28",
            health: Deferred.isDone(terminal).pipe(
              Effect.map((closed) => ({
                closed,
                cleanupUnconfirmed: false,
                observation: failed ? ("failed" as const) : ("active" as const),
              })),
            ),
          };
        }),
    });
    return f.run(function* (connections) {
      const retired = awaitStatus(
        connections,
        (status) => status.servers.find((server) => server.id === "a")?.state === "disconnected",
      );
      yield* call(connections);
      yield* failures[0]!;
      yield* retired;
      expect((yield* connections.status).servers.find((server) => server.id === "a")).toMatchObject(
        { state: "disconnected", observation: "failed" },
      );
      yield* call(connections);
      yield* failures[0]!; // A retired owner's late notification cannot overwrite the new owner.
      expect((yield* connections.status).servers.find((server) => server.id === "a")).toMatchObject(
        { state: "connected", protocolVersion: "2026-07-28", observation: "active" },
      );
      yield* failures[1]!;
      yield* retired;
      yield* f.replace({ ...f.config(), revision: f.config().revision + 1 });
      expect(
        (yield* connections.status).servers.find((server) => server.id === "a")?.observation,
      ).toBeUndefined();
    });
  },
);

it.live("retires expired HTTP sessions and reconnects only for a later explicit call", () =>
  Effect.gen(function* () {
    let initialized = 0;
    let calls = 0;
    const cleaned = yield* Deferred.make<void>();
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ method: Schema.String, id: Schema.optionalKey(Schema.Number) }),
      ),
    );
    const http = yield* startHttpServer((request) => {
      if (request.method === "GET")
        return Effect.succeed(HttpServerResponse.empty({ status: 405 }));
      if (request.method === "DELETE")
        return Effect.succeed(HttpServerResponse.empty({ status: 404 }));
      const message = decode(request.body);
      if (message.id === undefined)
        return Effect.succeed(HttpServerResponse.empty({ status: 202 }));
      if (message.method === "initialize") {
        initialized++;
        return Effect.succeed(
          HttpServerResponse.text(
            serialize({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-11-25",
                capabilities: { tools: {} },
                serverInfo: { name: "fixture", version: "1" },
              },
            }),
            {
              contentType: "application/json",
              headers: { "mcp-session-id": `session-${initialized}` },
            },
          ),
        );
      }
      calls++;
      return Effect.succeed(
        calls === 1
          ? HttpServerResponse.empty({ status: 404 })
          : HttpServerResponse.text(
              serialize({ jsonrpc: "2.0", id: message.id, result: { content: [] } }),
              { contentType: "application/json" },
            ),
      );
    });
    const f = fixture({
      open: () =>
        openSdkHttp({
          url: http.url,
          protocol: "legacy",
          connectTimeoutMs: 500,
          cleanupTimeoutMs: 500,
          onCleanup: (confirmed) => {
            if (confirmed) Deferred.doneUnsafe(cleaned, Effect.void);
          },
        }),
    });
    yield* f.run(function* (connections) {
      expect(yield* call(connections).pipe(Effect.flip)).toMatchObject({ outcome: "unknown" });
      yield* Effect.gen(function* () {
        yield* Deferred.await(cleaned);
        while (
          (yield* connections.status).servers.find((server) => server.id === "a")?.state !==
          "disconnected"
        )
          yield* Effect.sleep(1);
      }).pipe(
        Effect.timeoutOrElse({
          duration: 1_000,
          orElse: () => Effect.die("Session was not retired"),
        }),
      );
      expect(calls).toBe(1);
      expect(initialized).toBe(1);
      expect((yield* call(connections)).outcome).toBe("completed");
      expect(calls).toBe(2);
      expect(initialized).toBe(2);
      yield* connections.disconnect("a");
    });
  }),
);

it.effect("never clears static HTTP authorization through request admission and disconnect", () => {
  const f = fixture({
    config: httpConfig({ headers: { Authorization: "Bearer configured-secret" } }),
  });
  return f.run(function* (c) {
    expect((yield* call(c)).outcome).toBe("completed");
    expect((yield* call(c)).outcome).toBe("completed");
    expect(yield* c.disconnect("a")).toEqual({ servers: ["a"], cleanup: "confirmed" });
    expect(f.state.tokens).toEqual([]);
  });
});

it.effect(
  "credential changes revoke old owner authority and policy denial never reaches auth or SDK",
  () => {
    let token = 1;
    const f = fixture({ auth: Effect.sync(() => `private-token-${token}`) });
    return f.run(function* (c) {
      yield* call(c);
      token = 2;
      expect(yield* call(c).pipe(Effect.flip)).toMatchObject({
        kind: "stale",
        outcome: "not-sent",
      });
      expect(f.state.requests).toBe(1);
      yield* c.disconnect("a");
      yield* call(c);
      expect(f.state.tokens).toEqual(["private-token-1", "private-token-2"]);
      const accesses = f.state.accesses;
      expect(
        yield* Effect.result(c.withOperation("a", { tool: "denied" }, () => Effect.void)),
      ).toMatchObject({ failure: { kind: "denied" } });
      expect(f.state.accesses).toBe(accesses);
      expect(serialize(yield* c.status)).not.toContain("private-token");
    });
  },
);

for (const uncertain of [false, true]) {
  it.effect(`terminal-before-reply preserves completed publication, uncertain=${uncertain}`, () =>
    Effect.gen(function* () {
      const held = yield* gate();
      const f = fixture({ uncertain, terminalBeforeReply: true });
      yield* f.run(function* (c) {
        let published = false;
        const active = yield* Effect.forkScoped(
          c.withOperation("a", { tool: "write" }, (op) =>
            Effect.gen(function* () {
              const reply = yield* op.request({ action: "tools.call", tool: "write" });
              yield* held.pass;
              return yield* op.commit(
                Effect.sync(() => {
                  published = true;
                  return reply;
                }),
              );
            }),
          ),
        );
        yield* held.entered;
        expect(yield* Effect.result(call(c))).toMatchObject({
          failure: { kind: "busy", outcome: "not-sent" },
        });
        expect(f.state.closes).toBe(0);
        yield* held.open;
        expect((yield* Fiber.join(active)).outcome).toBe("completed");
        expect(published).toBe(true);
        expect((yield* c.disconnect("a")).cleanup).toBe(uncertain ? "unconfirmed" : "confirmed");
        expect(f.state.requests).toBe(1);
      });
    }),
  );
}

it.effect("cancellation revokes publication before waiting for request cleanup", () =>
  Effect.gen(function* () {
    const captured = yield* Deferred.make<McpOperation>();
    const entered = yield* Deferred.make<void>();
    const cleanup = yield* gate();
    const f = fixture({
      request: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(cleanup.pass),
        ),
    });
    yield* f.run(function* (c) {
      const active = yield* Effect.forkScoped(
        c.withOperation("a", {}, (op) =>
          Deferred.succeed(captured, op).pipe(
            Effect.andThen(op.request({ action: "tools.call", tool: "write" })),
          ),
        ),
      );
      const op = yield* Deferred.await(captured);
      yield* Deferred.await(entered);
      const cancellation = yield* Effect.forkScoped(Fiber.interrupt(active));
      yield* cleanup.entered;
      let published = false;
      expect(
        yield* Effect.result(op.commit(Effect.sync(() => void (published = true)))),
      ).toMatchObject({ failure: { kind: "stale" } });
      expect(published).toBe(false);
      expect((yield* c.status).active).toBe(1);
      yield* cleanup.open;
      yield* Fiber.join(cancellation);
      expect((yield* c.status).active).toBe(0);
      expect(f.state.closes).toBe(0);
    });
  }),
);

it.effect("a connection owner outlives its first waiter's shorter deadline", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const f = fixture({
      opening: Deferred.await(opening),
      settings: { requestTimeoutMs: 50, connectTimeoutMs: 100 },
    });
    yield* f.run(function* (c) {
      const first = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* yieldUntil(() => f.state.opens === 1, 1_000);
      yield* TestClock.adjust(50);
      expect(yield* Fiber.join(first)).toMatchObject({ failure: { kind: "timeout" } });
      const second = yield* Effect.forkScoped(call(c));
      yield* TestClock.adjust(25);
      yield* Deferred.succeed(opening, undefined);
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(f.state.opens).toBe(1);
    });
  }),
);

it.effect(
  "serializes user auth through interrupted callback cleanup without dropping a successor's gate",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* gate();
      const successor = yield* gate();
      const f = fixture();
      yield* f.run(function* (c) {
        yield* call(c);
        const first = yield* c
          .withAuth("a", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(cleaning.pass),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupted = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
        yield* cleaning.entered;
        const second = yield* c.withAuth("a", () => successor.pass).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* successor.hasEntered).toBe(false);
        expect((yield* c.requireServer("a")).id).toBe("a");
        expect(yield* call(c).pipe(Effect.flip)).toMatchObject({
          kind: "busy",
          outcome: "not-sent",
        });
        yield* cleaning.open;
        yield* Fiber.join(interrupted);
        yield* successor.entered;
        expect(yield* call(c).pipe(Effect.flip)).toMatchObject({
          kind: "busy",
          outcome: "not-sent",
        });
        expect(f.state.requests).toBe(1);
        yield* successor.open;
        yield* Fiber.join(second);
        expect((yield* call(c)).outcome).toBe("completed");
      });
    }),
);

it.effect("revalidates auth configuration and trust before reopening execution", () =>
  Effect.gen(function* () {
    for (const change of ["revision", "trust"] as const) {
      const held = yield* gate();
      const f = fixture();
      yield* f.run(function* (c) {
        const pending = yield* c
          .withAuth("a", () => held.pass)
          .pipe(Effect.result, Effect.forkChild);
        yield* held.entered;
        if (change === "revision") yield* f.replace({ ...f.config(), revision: 2 });
        else f.state.trusted = false;
        yield* held.open;
        expect(yield* Fiber.join(pending)).toMatchObject({
          failure: { kind: change === "revision" ? "stale" : "denied" },
        });
        expect(f.state.opens).toBe(0);
        if (change === "trust") {
          f.state.trusted = true;
          yield* f.replace({ ...f.config(), revision: 2, trusted: true });
        }
        expect(yield* call(c).pipe(Effect.flip)).toMatchObject({ kind: "busy" });
        yield* c.withAuth("a", () => Effect.void);
        expect((yield* call(c)).outcome).toBe("completed");
      });
    }
  }),
);

it.effect(
  "ended operation capabilities cannot publish even while their connection remains current",
  () => {
    const f = fixture();
    return f.run(function* (c) {
      const operation: McpOperation = yield* c.withOperation("a", {}, (op) => Effect.succeed(op));
      let published = false;
      expect(
        yield* Effect.result(operation.commit(Effect.sync(() => void (published = true)))),
      ).toMatchObject({ failure: { kind: "stale" } });
      expect(published).toBe(false);
    });
  },
);
