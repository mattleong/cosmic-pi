import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpServerResponse } from "effect/unstable/http";
import { McpActivity } from "../../src/activity/service.ts";
import { McpAuth } from "../../src/auth/service.ts";
import { McpConnector, type McpConnectorContract } from "../../src/boundary/sdk-connection.ts";
import { openSdkHttp } from "../../src/boundary/sdk-http.ts";
import { boundaryError, type McpBoundaryError } from "../../src/client/errors.ts";
import type { McpConnection, McpReply, McpRequest } from "../../src/client/model.ts";
import type { McpResolvedConfig, McpSettings } from "../../src/config/model.ts";
import { McpConfigStore } from "../../src/config/store.ts";
import type { McpConnectionsContract, McpOperation } from "../../src/connection/model.ts";
import { McpConnections } from "../../src/connection/service.ts";
import { startHttpServer } from "../fixtures/http-server.ts";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const defaults: McpSettings = {
  enabled: true,
  connectTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  idleTimeoutMs: 600_000,
  maxConcurrent: 8,
  maxPerServer: 4,
  maxQueued: 64,
};
const initialConfig = (settings?: Partial<McpSettings>): McpResolvedConfig => ({
  revision: 1,
  trusted: true,
  settings: { ...defaults, ...settings },
  diagnostics: [],
  servers: Object.fromEntries(
    ["a", "b"].map((id) => [
      id,
      {
        id,
        identity: `${id}-1`,
        enabled: true,
        scope: "global" as const,
        directory: "/private/secret-path",
        definition: {
          transport: "stdio" as const,
          command: "private-executable",
          args: [],
          environment: {},
          denyTools: ["denied"],
        },
      },
    ]),
  ),
});
interface FixtureOptions {
  readonly settings?: Partial<McpSettings>;
  readonly config?: McpResolvedConfig;
  readonly open?: McpConnectorContract["open"];
  readonly opening?: Effect.Effect<void, McpBoundaryError>;
  readonly closing?: Effect.Effect<void>;
  readonly uncertain?: boolean;
  readonly terminalBeforeReply?: boolean;
  readonly auth?: Effect.Effect<string | undefined, McpBoundaryError>;
  readonly request?: (input: McpRequest) => Effect.Effect<McpReply, McpBoundaryError>;
}
const fixture = (options: FixtureOptions = {}) => {
  let config = options.config ?? initialConfig(options.settings);
  let publish: ((next: McpResolvedConfig) => Effect.Effect<void>) | undefined;
  const tokens: Array<string | undefined> = [];
  let observedAuth: "none" | "required" = "none";
  const state = { trusted: true, opens: 0, closes: 0, accesses: 0, requests: 0, tokens };
  const replace = (next: McpResolvedConfig) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        config = next;
        if (publish) yield* publish(next);
        return next;
      }),
    );
  const dependencies = Layer.mergeAll(
    McpActivity.layer(),
    Layer.succeed(McpConfigStore, {
      snapshot: Effect.sync(() => config),
      subscribe: (listener) =>
        Effect.gen(function* () {
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              publish = listener;
            }),
            () =>
              Effect.sync(() => {
                publish = undefined;
              }),
          );
          yield* listener(config);
        }),
      reload: Effect.suspend(() => replace({ ...config, revision: config.revision + 1 })),
      setServer: () => Effect.succeed(config),
      removeServer: () => Effect.succeed(config),
      setSettings: () => Effect.succeed(config),
    }),
    Layer.succeed(McpAuth, {
      access: () =>
        Effect.gen(function* () {
          state.accesses += 1;
          return yield* options.auth ?? Effect.succeed(undefined);
        }),
      status: () => Effect.succeed({ state: observedAuth }),
      login: () => Effect.succeed({ state: "none" }),
      logout: () => Effect.void,
      reject: () =>
        Effect.sync(() => {
          observedAuth = "required";
        }),
      completeLogin: () => Effect.void,
      finalizationFailed: () => Effect.void,
      revoke: Effect.void,
    }),
    Layer.succeed(McpConnector, {
      open: (server, settings, token) =>
        Effect.gen(function* () {
          state.opens += 1;
          yield* options.opening ?? Effect.void;
          if (options.open) return yield* options.open(server, settings, token);
          const terminal = yield* Deferred.make<void, McpBoundaryError>();
          let closed = false;
          const close = Effect.uninterruptible(
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
          );
          const connection: McpConnection = {
            capabilities: { tools: true, resources: true, prompts: true },
            changes: Stream.empty,
            terminal: Deferred.await(terminal),
            health: Effect.sync(() => ({ closed, cleanupUnconfirmed: options.uncertain === true })),
            close,
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
          };
          return yield* Effect.acquireRelease(Effect.succeed(connection), () =>
            close.pipe(Effect.catch(() => Effect.void)),
          );
        }),
    }),
  );
  return {
    state,
    config: () => config,
    replace,
    layer: McpConnections.layer({ isTrusted: () => state.trusted }).pipe(
      Layer.provide(dependencies),
    ),
  };
};
const call = (connections: McpConnectionsContract, server = "a") =>
  connections.withOperation(server, { tool: "write" }, (op) =>
    op.request({ action: "tools.call", tool: "write" }),
  );
const until = (predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let n = 0; n < 1_000 && !predicate(); n += 1) yield* Effect.yieldNow;
    expect(predicate()).toBe(true);
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
        const config = initialConfig();
        const current = config.servers.a!;
        const configured = {
          ...config,
          servers: {
            a: {
              ...current,
              definition: {
                transport: "http" as const,
                url: "https://private.example/mcp",
                headers: { Authorization: "private-header" },
                denyTools: [],
                auth,
              },
            },
          },
        };
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
          yield* Effect.gen(function* () {
            const c = yield* McpConnections;
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
            expect(f.config()).toBe(configured);
          }).pipe(Effect.provide(f.layer));
        }
      }
    }),
);

it.effect("only current-owner auth-specific transport rejection changes auth evidence", () =>
  Effect.gen(function* () {
    const authFailure = fixture({
      request: () => Effect.fail(boundaryError("auth-required", "not-sent", "rejected")),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      yield* Effect.result(call(c));
      expect((yield* c.status).servers[0]?.auth).toBe("required");
    }).pipe(Effect.provide(authFailure.layer));
    const permission = fixture({
      request: (request) =>
        Effect.succeed({
          action: request.action,
          outcome: "completed",
          result: { isError: true, content: [{ type: "text", text: "permission denied" }] },
        }),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      yield* call(c);
      expect((yield* c.status).servers[0]?.auth).toBe("none");
    }).pipe(Effect.provide(permission.layer));
    const forbidden = fixture({
      request: () => Effect.fail(boundaryError("denied", "unknown", "HTTP policy denial")),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      yield* Effect.result(call(c));
      expect((yield* c.status).servers[0]?.auth).toBe("none");
    }).pipe(Effect.provide(forbidden.layer));
  }),
);

it.effect("an auth rejection arriving after lost trust cannot publish new auth evidence", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = fixture({
      request: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.fail(boundaryError("auth-required", "not-sent", "rejected"))),
        ),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const pending = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* Deferred.await(entered);
      f.state.trusted = false;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(pending);
      f.state.trusted = true;
      expect((yield* c.status).servers[0]?.auth).toBe("none");
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("status does not connect, resolve credentials, or expose config details", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const c = yield* McpConnections;
    const status = yield* c.status;
    expect(status.servers[0]).toMatchObject({ id: "a", state: "disconnected" });
    expect(serialize(status)).not.toMatch(/secret-path|private-executable/);
    expect(f.state.opens).toBe(0);
    expect(f.state.accesses).toBe(0);
  }).pipe(Effect.provide(f.layer));
});

it.effect("availability is a synchronous projection without I/O or authority mutation", () =>
  Effect.gen(function* () {
    const f = fixture();
    let available: () => boolean = () => false;
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
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
        settings: { ...defaults, enabled: false },
      });
      expect(available()).toBe(false);
      yield* f.replace({ ...f.config(), revision: 4, settings: defaults });
      expect(available()).toBe(true);
      expect(f.state.accesses).toBe(0);
      expect(f.state.opens).toBe(0);
    }).pipe(Effect.provide(f.layer));
    expect(available()).toBe(false);
  }),
);

it.effect("concurrent connection waiters share an owner and cancellation is local", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const f = fixture({ opening: Deferred.await(opening) });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const first = yield* Effect.forkScoped(call(c));
      yield* until(() => f.state.opens === 1);
      const second = yield* Effect.forkScoped(call(c));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      expect(f.state.closes).toBe(0);
      yield* Deferred.succeed(opening, undefined);
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(f.state.opens).toBe(1);
      expect(f.state.requests).toBe(1);
    }).pipe(Effect.provide(f.layer));
    expect(f.state.closes).toBe(1);
  }),
);

it.effect("queued calls expire from initial admission and never dispatch late", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const f = fixture({
      settings: { maxConcurrent: 1, maxPerServer: 1, requestTimeoutMs: 100 },
      request: (input) =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as({ action: input.action, outcome: "completed", result: {} }),
        ),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const active = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* Deferred.await(entered);
      const queued = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(100);
      expect(yield* Fiber.join(queued)).toMatchObject({
        failure: { kind: "timeout", outcome: "not-sent" },
      });
      expect(yield* Fiber.join(active)).toMatchObject({
        failure: { kind: "timeout", outcome: "unknown" },
      });
      yield* Deferred.succeed(release, undefined);
      expect(f.state.requests).toBe(1);
      expect(yield* c.status).toMatchObject({ active: 0, queued: 0 });
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("one dispatch slot does not deadlock shared metadata or cancel its peer", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let owners = 0;
    const f = fixture({ settings: { maxConcurrent: 1, maxPerServer: 1 } });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const metadata = () =>
        c.withOperation("a", {}, (op) =>
          op.shared("metadata", (owned) =>
            Effect.gen(function* () {
              owners += 1;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return yield* owned.request({ action: "tools.list" });
            }),
          ),
        );
      const first = yield* Effect.forkScoped(metadata());
      yield* Deferred.await(entered);
      const second = yield* Effect.forkScoped(metadata());
      yield* TestClock.adjust(0);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(owners).toBe(1);
      expect(f.state.requests).toBe(1);
    }).pipe(Effect.provide(f.layer));
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
      yield* Effect.gen(function* () {
        const c = yield* McpConnections;
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
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("connection notifications can start a fresh shared ticket after their caller ends", () =>
  Effect.gen(function* () {
    const notify = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const f = fixture({ settings: { requestTimeoutMs: 100 } });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
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
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "active operations prevent idle close and stale timer generations cannot close reuse",
  () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const f = fixture({ settings: { idleTimeoutMs: 100 } });
      yield* Effect.gen(function* () {
        const c = yield* McpConnections;
        yield* c.connect("a");
        yield* TestClock.adjust(50);
        const active = yield* Effect.forkScoped(
          c.withOperation("a", {}, () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(hold))),
          ),
        );
        yield* Deferred.await(entered);
        yield* TestClock.adjust(100);
        expect(f.state.closes).toBe(0);
        yield* Deferred.succeed(hold, undefined);
        yield* Fiber.join(active);
        yield* TestClock.adjust(99);
        expect(f.state.closes).toBe(0);
        yield* TestClock.adjust(1);
        yield* until(() => f.state.closes === 1);
        yield* c.connect("a");
        expect(f.state.opens).toBe(2);
      }).pipe(Effect.provide(f.layer));
      expect(f.state.closes).toBe(2);
    }),
);

it.effect("unrelated config edits revoke accepted-result retention before commit returns", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const cleanupEntered = yield* Deferred.make<void>();
    const cleanupDone = yield* Deferred.make<void>();
    let resultId: string | undefined;
    const f = fixture({
      closing: Deferred.succeed(cleanupEntered, undefined).pipe(
        Effect.andThen(Deferred.await(cleanupDone)),
      ),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
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
            op.request({ action: "tools.call", tool: "write" }).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Deferred.await(finish)),
              Effect.andThen(
                op.commit(
                  Effect.sync(() => {
                    resultId = "old-revision-result";
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      yield* Deferred.await(entered);
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
      yield* Deferred.await(cleanupEntered);
      expect(notices).toEqual([["a", "b"]]);
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "busy" } });
      yield* Deferred.succeed(finish, undefined);
      expect(yield* Fiber.join(old)).toMatchObject({
        failure: { kind: "stale", outcome: "completed" },
      });
      expect(resultId).toBeUndefined();
      yield* Deferred.succeed(cleanupDone, undefined);
      yield* c.disconnect("a");
      yield* c.connect("a");
      expect(f.state.opens).toBe(2);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("live trust loss revokes connections and output before any new credential lookup", () =>
  Effect.gen(function* () {
    const f = fixture();
    let published = false;
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const result = yield* Effect.result(
        c.withOperation("a", { tool: "write" }, (op) =>
          Effect.gen(function* () {
            yield* op.request({ action: "tools.call", tool: "write" });
            f.state.trusted = false;
            return yield* op.commit(
              Effect.sync(() => {
                published = true;
              }),
            );
          }),
        ),
      );
      expect(result).toMatchObject({ failure: { kind: "stale", outcome: "completed" } });
      const accesses = f.state.accesses;
      expect(yield* Effect.result(call(c))).toMatchObject({ failure: { kind: "denied" } });
      expect(f.state.accesses).toBe(accesses);
      expect(published).toBe(false);
      expect((yield* c.status).trusted).toBe(false);
    }).pipe(Effect.provide(f.layer));
    expect(f.state.closes).toBe(1);
  }),
);

it.effect("disconnect preserves result authority while explicit revoke notifies it", () => {
  const f = fixture();
  return Effect.gen(function* () {
    const c = yield* McpConnections;
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
  }).pipe(Effect.provide(f.layer));
});

it.effect(
  "unconfirmed cleanup leaves a blocked tombstone instead of starting a replacement",
  () => {
    const f = fixture({ uncertain: true });
    return Effect.gen(function* () {
      const c = yield* McpConnections;
      yield* c.connect("a");
      expect(yield* c.disconnect("a")).toMatchObject({ cleanup: "unconfirmed" });
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "cleanup" } });
      yield* f.replace({ ...f.config(), revision: 2 });
      expect(yield* Effect.result(c.connect("a"))).toMatchObject({ failure: { kind: "cleanup" } });
      expect(f.state.opens).toBe(1);
    }).pipe(Effect.provide(f.layer));
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
  return Effect.gen(function* () {
    const c = yield* McpConnections;
    expect(yield* Effect.result(call(c))).toMatchObject({ failure: { kind: "connection" } });
    yield* c.disconnect("a");
    expect((yield* call(c)).outcome).toBe("completed");
    expect(f.state.requests).toBe(1);
    expect(f.state.opens).toBe(2);
  }).pipe(Effect.provide(f.layer));
});

it.live("preserves static HTTP authorization through request admission and disconnect", () =>
  Effect.gen(function* () {
    const authorization = "Bearer configured-secret";
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(
        Schema.Struct({ method: Schema.String, id: Schema.optionalKey(Schema.Finite) }),
      ),
    );
    const http = yield* startHttpServer((request) => {
      if (request.headers.authorization !== authorization)
        return Effect.succeed(HttpServerResponse.empty({ status: 401 }));
      if (request.method === "GET")
        return Effect.succeed(HttpServerResponse.empty({ status: 405 }));
      if (request.method === "DELETE")
        return Effect.succeed(HttpServerResponse.empty({ status: 204 }));
      const message = decode(request.body);
      if (message.id === undefined)
        return Effect.succeed(HttpServerResponse.empty({ status: 202 }));
      const initialize = message.method === "initialize";
      return Effect.succeed(
        HttpServerResponse.text(
          serialize({
            jsonrpc: "2.0",
            id: message.id,
            result: initialize
              ? {
                  protocolVersion: "2025-11-25",
                  capabilities: { tools: {} },
                  serverInfo: { name: "fixture", version: "1" },
                }
              : { content: [{ type: "text", text: "ok" }] },
          }),
          {
            contentType: "application/json",
            headers: initialize ? { "mcp-session-id": "fixture-session" } : {},
          },
        ),
      );
    });
    const config = initialConfig();
    const f = fixture({
      config: {
        ...config,
        servers: {
          a: {
            ...config.servers.a!,
            definition: {
              transport: "http",
              url: http.url.href,
              headers: { Authorization: authorization },
              auth: { type: "none" },
              denyTools: [],
            },
          },
        },
      },
      open: (server, settings, token) => {
        const definition = server.definition;
        if (definition?.transport !== "http")
          return Effect.die("Expected HTTP fixture configuration.");
        return openSdkHttp({
          url: new URL(definition.url),
          headers: definition.headers,
          ...(token !== undefined && { token }),
          connectTimeoutMs: settings.connectTimeoutMs,
          requestTimeoutMs: settings.requestTimeoutMs,
        });
      },
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      expect((yield* call(c)).outcome).toBe("completed");
      expect((yield* call(c)).outcome).toBe("completed");
      expect(yield* c.disconnect("a")).toEqual({ servers: ["a"], cleanup: "confirmed" });
      expect(http.requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(
        http.requests.every((request) => request.headers.authorization === authorization),
      ).toBe(true);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "every dispatch refreshes its token and policy denial never reaches auth or the SDK",
  () => {
    let token = 0;
    const f = fixture({ auth: Effect.sync(() => `private-token-${++token}`) });
    return Effect.gen(function* () {
      const c = yield* McpConnections;
      yield* call(c);
      yield* call(c);
      expect(f.state.tokens).toEqual(["private-token-2", "private-token-3"]);
      const accesses = f.state.accesses;
      expect(
        yield* Effect.result(c.withOperation("a", { tool: "denied" }, () => Effect.void)),
      ).toMatchObject({ failure: { kind: "denied" } });
      expect(f.state.accesses).toBe(accesses);
      expect(serialize(yield* c.status)).not.toContain("private-token");
    }).pipe(Effect.provide(f.layer));
  },
);

for (const uncertain of [false, true]) {
  it.effect(`terminal-before-reply preserves completed publication, uncertain=${uncertain}`, () =>
    Effect.gen(function* () {
      const finish = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const f = fixture({ uncertain, terminalBeforeReply: true });
      yield* Effect.gen(function* () {
        const c = yield* McpConnections;
        let published = false;
        const active = yield* Effect.forkScoped(
          c.withOperation("a", { tool: "write" }, (op) =>
            Effect.gen(function* () {
              const reply = yield* op.request({ action: "tools.call", tool: "write" });
              yield* Deferred.succeed(received, undefined);
              yield* Deferred.await(finish);
              return yield* op.commit(
                Effect.sync(() => {
                  published = true;
                  return reply;
                }),
              );
            }),
          ),
        );
        yield* Deferred.await(received);
        expect(yield* Effect.result(call(c))).toMatchObject({
          failure: { kind: "busy", outcome: "not-sent" },
        });
        expect(f.state.closes).toBe(0);
        yield* Deferred.succeed(finish, undefined);
        expect((yield* Fiber.join(active)).outcome).toBe("completed");
        expect(published).toBe(true);
        expect((yield* c.disconnect("a")).cleanup).toBe(uncertain ? "unconfirmed" : "confirmed");
        expect(f.state.requests).toBe(1);
      }).pipe(Effect.provide(f.layer));
    }),
  );
}

it.effect("cancellation revokes publication before waiting for request cleanup", () =>
  Effect.gen(function* () {
    const captured = yield* Deferred.make<McpOperation>();
    const entered = yield* Deferred.make<void>();
    const cleanupEntered = yield* Deferred.make<void>();
    const cleanupDone = yield* Deferred.make<void>();
    const f = fixture({
      request: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(cleanupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupDone)),
            ),
          ),
        ),
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
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
      yield* Deferred.await(cleanupEntered);
      let published = false;
      expect(
        yield* Effect.result(
          op.commit(
            Effect.sync(() => {
              published = true;
            }),
          ),
        ),
      ).toMatchObject({ failure: { kind: "stale" } });
      expect(published).toBe(false);
      expect((yield* c.status).active).toBe(1);
      yield* Deferred.succeed(cleanupDone, undefined);
      yield* Fiber.join(cancellation);
      expect((yield* c.status).active).toBe(0);
      expect(f.state.closes).toBe(0);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("a connection owner outlives its first waiter's shorter deadline", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const f = fixture({
      opening: Deferred.await(opening),
      settings: { requestTimeoutMs: 50, connectTimeoutMs: 100 },
    });
    yield* Effect.gen(function* () {
      const c = yield* McpConnections;
      const first = yield* Effect.forkScoped(Effect.result(call(c)));
      yield* until(() => f.state.opens === 1);
      yield* TestClock.adjust(50);
      expect(yield* Fiber.join(first)).toMatchObject({ failure: { kind: "timeout" } });
      const second = yield* Effect.forkScoped(call(c));
      yield* TestClock.adjust(25);
      yield* Deferred.succeed(opening, undefined);
      expect((yield* Fiber.join(second)).outcome).toBe("completed");
      expect(f.state.opens).toBe(1);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect(
  "serializes user auth through interrupted callback cleanup without dropping a successor's gate",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const cleanup = yield* Deferred.make<void>();
      const successorEntered = yield* Deferred.make<void>();
      const successorDone = yield* Deferred.make<void>();
      const f = fixture();
      yield* Effect.gen(function* () {
        const c = yield* McpConnections;
        yield* call(c);
        const first = yield* c
          .withAuth("a", () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(cleanup))),
              ),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupted = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
        yield* Deferred.await(cleaning);
        const second = yield* c
          .withAuth("a", () =>
            Deferred.succeed(successorEntered, undefined).pipe(
              Effect.andThen(Deferred.await(successorDone)),
            ),
          )
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(successorEntered)).toBe(false);
        expect((yield* c.requireServer("a")).id).toBe("a");
        expect(yield* call(c).pipe(Effect.flip)).toMatchObject({
          kind: "busy",
          outcome: "not-sent",
        });
        yield* Deferred.succeed(cleanup, undefined);
        yield* Fiber.join(interrupted);
        yield* Deferred.await(successorEntered);
        expect(yield* call(c).pipe(Effect.flip)).toMatchObject({
          kind: "busy",
          outcome: "not-sent",
        });
        expect(f.state.requests).toBe(1);
        yield* Deferred.succeed(successorDone, undefined);
        yield* Fiber.join(second);
        expect((yield* call(c)).outcome).toBe("completed");
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect("revalidates auth configuration and trust before reopening execution", () =>
  Effect.gen(function* () {
    for (const change of ["revision", "trust"] as const) {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const f = fixture();
      yield* Effect.gen(function* () {
        const c = yield* McpConnections;
        const pending = yield* c
          .withAuth("a", () =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        if (change === "revision") yield* f.replace({ ...f.config(), revision: 2 });
        else f.state.trusted = false;
        yield* Deferred.succeed(release, undefined);
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
      }).pipe(Effect.provide(f.layer));
    }
  }),
);

it.effect(
  "ended operation capabilities cannot publish even while their connection remains current",
  () => {
    const f = fixture();
    return Effect.gen(function* () {
      const c = yield* McpConnections;
      const operation: McpOperation = yield* c.withOperation("a", {}, (op) => Effect.succeed(op));
      let published = false;
      expect(
        yield* Effect.result(
          operation.commit(
            Effect.sync(() => {
              published = true;
            }),
          ),
        ),
      ).toMatchObject({ failure: { kind: "stale" } });
      expect(published).toBe(false);
    }).pipe(Effect.provide(f.layer));
  },
);
