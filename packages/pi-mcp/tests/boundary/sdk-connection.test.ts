import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vitest";
import * as Core from "pi-cosmic-core";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import * as Stdio from "../../src/boundary/sdk-stdio.ts";
import * as Http from "../../src/boundary/sdk-http.ts";
import type { McpConnection } from "../../src/client/model.ts";
import type { McpEffectiveServer, McpSettings } from "../../src/config/model.ts";

const settings: McpSettings = {
  enabled: true,
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  idleTimeoutMs: 1000,
  maxConcurrent: 8,
  maxPerServer: 4,
  maxQueued: 64,
};
const server = (id: string): McpEffectiveServer => ({
  id,
  directory: "/fixture/mcp",
  scope: "project",
  identity: id,
  enabled: true,
  definition: { transport: "stdio", command: "fixture", args: [], denyTools: [], environment: {} },
});
const makeConnector = (env: Record<string, string> = {}) =>
  McpConnector.pipe(
    Effect.provide(McpConnector.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
  );
const fakeConnection = (onCleanup: ((confirmed: boolean) => void) | undefined) =>
  Effect.gen(function* () {
    let closed = false;
    const close = Effect.sync(() => {
      if (closed) return;
      closed = true;
      onCleanup?.(true);
    });
    yield* Effect.addFinalizer(() => close);
    return {
      capabilities: { tools: true, resources: false, prompts: false },
      changes: Stream.empty,
      terminal: Effect.never,
      health: Effect.sync(() => ({ closed, cleanupUnconfirmed: false })),
      setToken: () => Effect.void,
      request: (input) =>
        Effect.succeed({ action: input.action, outcome: "completed", result: {} }),
      close,
    } satisfies McpConnection;
  });

afterEach(() => vi.restoreAllMocks());

it.effect("resolves environment interpolation at connection time using its captured provider", () =>
  Effect.gen(function* () {
    const environment = {
      PATH: "/fixture/bin",
      MCP_SECRET: "first",
      NESTED: "${OTHER}",
      OTHER: "not-recursed",
      PI_API_KEY: "not-for-child",
      HOME: "/private/home",
    };
    const connector = yield* makeConnector(environment);
    environment.MCP_SECRET = "rotated";
    let captured: Stdio.SdkStdioOptions | undefined;
    vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) => {
      captured = options;
      return fakeConnection(options.onCleanup);
    });
    const target: McpEffectiveServer = {
      ...server("env"),
      definition: {
        transport: "stdio",
        command: "fixture",
        args: [],
        cwd: "relative",
        denyTools: [],
        environment: {
          TOKEN: "${MCP_SECRET}",
          LITERAL: "literal",
          ESCAPED: "$${MCP_SECRET}",
          NONRECURSIVE: "${NESTED}",
        },
      },
    };
    const connection = yield* connector
      .open(target, settings)
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ MCP_SECRET: "wrong-runtime" }),
        ),
      );
    expect(captured?.environment).toEqual({
      PATH: "/fixture/bin",
      TOKEN: "rotated",
      LITERAL: "literal",
      ESCAPED: "${MCP_SECRET}",
      NONRECURSIVE: "${OTHER}",
    });
    expect(captured?.cwd).toBe("/fixture/mcp/relative");
    yield* connection.close;
    const minimal = yield* makeConnector();
    yield* minimal.open(server("minimal-env"), settings);
    expect(captured?.environment).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  }),
);

it.effect("rejects missing variables before connection acquisition without leaking names", () =>
  Effect.gen(function* () {
    let opened = false;
    vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) => {
      opened = true;
      return fakeConnection(options.onCleanup);
    });
    const connector = yield* makeConnector({ PRESENT: "ok" });
    const result = yield* connector
      .open(
        {
          ...server("missing-variable"),
          definition: {
            transport: "stdio",
            command: "fixture",
            args: [],
            denyTools: [],
            environment: { TOKEN: "prefix-${MISSING}-suffix" },
          },
        },
        settings,
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "config", outcome: "not-sent" },
    });
    expect(String(result)).not.toContain("MISSING");
    expect(opened).toBe(false);
  }),
);

it.effect("rejects expanded header injection and oversized values before HTTP acquisition", () =>
  Effect.gen(function* () {
    let opened = false;
    vi.spyOn(Http, "openSdkHttp").mockImplementation((options) => {
      opened = true;
      return fakeConnection(options.onCleanup);
    });
    vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) => {
      opened = true;
      return fakeConnection(options.onCleanup);
    });
    const connector = yield* makeConnector({
      BAD: "safe\r\nInjected: secret",
      LONG: "x".repeat(8_193),
      HALF: "x".repeat(4_097),
      NUL: "safe\0value",
    });
    for (const value of ["${BAD}", "${LONG}", "${HALF}${HALF}", "${NUL}"]) {
      const result = yield* connector
        .open(
          {
            ...server(`unsafe-${value}`),
            definition: {
              transport: "http",
              url: "https://example.test/mcp",
              denyTools: [],
              headers: { "x-fixture": value },
              auth: { type: "none" },
            },
          },
          settings,
        )
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "config", outcome: "not-sent" },
      });
      expect(String(result)).not.toContain("BAD");
    }
    const stdio = yield* connector
      .open(
        {
          ...server("unsafe-stdio"),
          definition: {
            transport: "stdio",
            command: "fixture",
            args: [],
            denyTools: [],
            environment: { value: "${NUL}" },
          },
        },
        settings,
      )
      .pipe(Effect.result);
    expect(stdio).toMatchObject({
      _tag: "Failure",
      failure: { kind: "config", outcome: "not-sent" },
    });
    expect(opened).toBe(false);
  }),
);

it.effect("resolves explicit HTTP headers and env bearer credentials without acquiring early", () =>
  Effect.gen(function* () {
    let captured: Http.SdkHttpOptions | undefined;
    vi.spyOn(Http, "openSdkHttp").mockImplementation((options) => {
      captured = options;
      return fakeConnection(options.onCleanup);
    });
    const connector = yield* makeConnector({ HEADER: "bound", BEARER: "private-token" });
    expect(captured).toBeUndefined();
    yield* connector.open(
      {
        ...server("http-env"),
        definition: {
          transport: "http",
          url: "https://example.test/mcp",
          denyTools: [],
          headers: { "x-fixture": "${HEADER}" },
          auth: { type: "env", env: "BEARER" },
        },
      },
      settings,
    );
    expect(captured?.headers).toEqual({ "x-fixture": "bound" });
    expect(captured?.token).toBe("private-token");
  }),
);

it.effect(
  "rejects remote HTTP bearer destinations before looking up missing environment credentials",
  () =>
    Effect.gen(function* () {
      const opened = vi.spyOn(Http, "openSdkHttp");
      const connector = yield* makeConnector();
      const failure = yield* connector
        .open(
          {
            ...server("remote-bearer"),
            definition: {
              transport: "http",
              url: "http://remote.test/mcp",
              denyTools: [],
              headers: {},
              auth: { type: "env", env: "MISSING_SECRET" },
            },
          },
          settings,
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({
        kind: "denied",
        outcome: "not-sent",
        reason: "oauth-binding-rejected",
      });
      expect(opened).not.toHaveBeenCalled();
    }),
);

it.effect(
  "holds connection admission across connector and scope replacement until confirmed close",
  () =>
    Effect.gen(function* () {
      vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) =>
        fakeConnection(options.onCleanup),
      );
      const first = yield* makeConnector();
      const second = yield* makeConnector();
      const oldScope = yield* Scope.fork(yield* Effect.scope);
      const target = server("scope-replacement");
      yield* first.open(target, settings).pipe(Effect.provideService(Scope.Scope, oldScope));
      expect(
        yield* second.open({ ...target, identity: "changed-target" }, settings).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { kind: "cleanup", outcome: "not-sent" },
      });
      yield* Scope.close(oldScope, Exit.void);
      const replacement = yield* second.open(target, settings);
      expect(yield* replacement.health).toMatchObject({ closed: false });
    }),
);

it.effect.each([
  { confirmed: true, replaceScope: false },
  { confirmed: false, replaceScope: false },
  { confirmed: true, replaceScope: true },
  { confirmed: false, replaceScope: true },
])("startup cancellation retains ownership through cleanup: %s", ({ confirmed, replaceScope }) =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const cleaning = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const observed: boolean[] = [];
    vi.spyOn(Core, "openDuplexProcess").mockImplementation((options) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(cleaning, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                options.onCleanup?.(confirmed);
                observed.push(confirmed);
              }),
            ),
          ),
        );
        yield* Deferred.succeed(started, undefined);
        return yield* Effect.never;
      }),
    );
    const first = yield* makeConnector();
    const target = server(`startup-interrupt-${confirmed}-${replaceScope}`);
    const oldScope = yield* Scope.fork(yield* Effect.scope);
    const opening = yield* first
      .open(target, settings)
      .pipe(Effect.provideService(Scope.Scope, oldScope), Effect.forkChild);
    yield* Deferred.await(started);
    const interrupt = yield* (
      replaceScope ? Scope.close(oldScope, Exit.void) : Fiber.interrupt(opening)
    ).pipe(Effect.forkChild);
    yield* Deferred.await(cleaning);
    const replacement = yield* makeConnector();
    expect(yield* replacement.open(target, settings).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { kind: "cleanup" },
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupt);
    expect(observed).toEqual([confirmed]);
    vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) =>
      fakeConnection(options.onCleanup),
    );
    const retried = yield* replacement.open(target, settings).pipe(Effect.result);
    expect(retried._tag).toBe(confirmed ? "Success" : "Failure");
  }),
);
