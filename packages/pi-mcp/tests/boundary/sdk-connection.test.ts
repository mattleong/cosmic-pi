import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { afterEach, vi } from "vitest";
import * as Core from "pi-cosmic-core";
import { McpConnector } from "../../src/boundary/sdk-connection.ts";
import * as Stdio from "../../src/boundary/sdk-stdio.ts";
import * as Http from "../../src/boundary/sdk-http.ts";
import { boundaryError } from "../../src/client/errors.ts";
import type { McpServerDefinition } from "../../src/config/model.ts";
import {
  fakeConnection,
  httpDefinition,
  stdioDefinition,
  testServer,
  testSettings,
} from "../fixtures/services.ts";

const settings = testSettings({
  connectTimeoutMs: 1000,
  requestTimeoutMs: 1000,
  idleTimeoutMs: 1000,
});
type Definition<T> = Partial<Extract<McpServerDefinition, { transport: T }>>;
const server = (id: string, definition: McpServerDefinition) =>
  testServer(id, { identity: id, scope: "project", directory: "/fixture/mcp", definition });
const stdioServer = (id: string, definition: Definition<"stdio"> = {}) =>
  server(id, stdioDefinition(definition));
const httpServer = (id: string, definition: Definition<"http"> = {}) =>
  server(id, httpDefinition(definition));
const makeConnector = (env: Record<string, string> = {}) =>
  McpConnector.pipe(
    Effect.provide(McpConnector.layer),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(env)),
  );
const cleanupOnClose = (onCleanup: ((confirmed: boolean) => void) | undefined) =>
  fakeConnection((terminal) => ({
    close: Deferred.succeed(terminal, undefined).pipe(
      Effect.map((first) => {
        if (first) onCleanup?.(true);
      }),
    ),
  }));

/** Replace the stdio opener with a fake connection and record each option set it receives. */
const spyStdio = () => {
  const opened: Stdio.SdkStdioOptions[] = [];
  vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) => {
    opened.push(options);
    return cleanupOnClose(options.onCleanup);
  });
  return opened;
};
const spyHttp = () => {
  const opened: Http.SdkHttpOptions[] = [];
  vi.spyOn(Http, "openSdkHttp").mockImplementation((options) => {
    opened.push(options);
    return cleanupOnClose(options.onCleanup);
  });
  return opened;
};

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
    const opened = spyStdio();
    const target = stdioServer("env", {
      cwd: "relative",
      environment: {
        TOKEN: "${MCP_SECRET}",
        LITERAL: "literal",
        ESCAPED: "$${MCP_SECRET}",
        NONRECURSIVE: "${NESTED}",
      },
    });
    const connection = yield* connector
      .open(target, settings)
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ MCP_SECRET: "wrong-runtime" }),
        ),
      );
    expect(opened[0]?.environment).toEqual({
      PATH: "/fixture/bin",
      TOKEN: "rotated",
      LITERAL: "literal",
      ESCAPED: "${MCP_SECRET}",
      NONRECURSIVE: "${OTHER}",
    });
    expect(opened[0]?.cwd).toBe("/fixture/mcp/relative");
    yield* connection.close;
    const minimal = yield* makeConnector();
    yield* minimal.open(stdioServer("minimal-env"), settings);
    expect(opened[1]?.environment).toEqual({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  }),
);

it.effect("rejects missing variables before connection acquisition without leaking names", () =>
  Effect.gen(function* () {
    const opened = spyStdio();
    const connector = yield* makeConnector({ PRESENT: "ok" });
    const result = yield* connector
      .open(
        stdioServer("missing-variable", { environment: { TOKEN: "prefix-${MISSING}-suffix" } }),
        settings,
      )
      .pipe(Effect.result);
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { kind: "config", outcome: "not-sent" },
    });
    expect(String(result)).not.toContain("MISSING");
    expect(opened).toEqual([]);
  }),
);

it.effect("rejects expanded header injection and oversized values before HTTP acquisition", () =>
  Effect.gen(function* () {
    const opened = [spyHttp(), spyStdio()];
    const connector = yield* makeConnector({
      BAD: "safe\r\nInjected: secret",
      LONG: "x".repeat(8_193),
      HALF: "x".repeat(4_097),
      NUL: "safe\0value",
    });
    for (const value of ["${BAD}", "${LONG}", "${HALF}${HALF}", "${NUL}"]) {
      const result = yield* connector
        .open(httpServer(`unsafe-${value}`, { headers: { "x-fixture": value } }), settings)
        .pipe(Effect.result);
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { kind: "config", outcome: "not-sent" },
      });
      expect(String(result)).not.toContain("BAD");
    }
    expect(
      yield* connector
        .open(stdioServer("unsafe-stdio", { environment: { value: "${NUL}" } }), settings)
        .pipe(Effect.flip),
    ).toMatchObject({ kind: "config", outcome: "not-sent" });
    expect(opened).toEqual([[], []]);
  }),
);

it.effect("resolves explicit HTTP headers and env bearer credentials without acquiring early", () =>
  Effect.gen(function* () {
    const opened = spyHttp();
    const connector = yield* makeConnector({ HEADER: "bound", BEARER: "private-token" });
    expect(opened).toEqual([]);
    yield* connector.open(
      httpServer("http-env", {
        headers: { "x-fixture": "${HEADER}" },
        auth: { type: "env", env: "BEARER" },
      }),
      settings,
    );
    expect(opened[0]?.headers).toEqual({ "x-fixture": "bound" });
    expect(opened[0]?.token).toBe("private-token");
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
          httpServer("remote-bearer", {
            url: "http://remote.test/mcp",
            auth: { type: "env", env: "MISSING_SECRET" },
          }),
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
      spyStdio();
      const first = yield* makeConnector();
      const second = yield* makeConnector();
      const oldScope = yield* Scope.fork(yield* Effect.scope);
      const target = stdioServer("scope-replacement");
      yield* first.open(target, settings).pipe(Effect.provideService(Scope.Scope, oldScope));
      expect(
        yield* second.open({ ...target, identity: "changed-target" }, settings).pipe(Effect.flip),
      ).toMatchObject({ kind: "cleanup", outcome: "not-sent" });
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
    const forwarded: boolean[] = [];
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
    const target = stdioServer(`startup-interrupt-${confirmed}-${replaceScope}`);
    const oldScope = yield* Scope.fork(yield* Effect.scope);
    const opening = yield* first
      .open(target, settings, undefined, (cleanup) => {
        forwarded.push(cleanup);
        throw new Error("Observer failure must not interrupt cleanup");
      })
      .pipe(Effect.provideService(Scope.Scope, oldScope), Effect.forkChild);
    yield* Deferred.await(started);
    const interrupt = yield* (
      replaceScope ? Scope.close(oldScope, Exit.void) : Fiber.interrupt(opening)
    ).pipe(Effect.forkChild);
    yield* Deferred.await(cleaning);
    const replacement = yield* makeConnector();
    expect(yield* replacement.open(target, settings).pipe(Effect.flip)).toMatchObject({
      kind: "cleanup",
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupt);
    expect(observed).toEqual([confirmed]);
    expect(forwarded).toEqual([confirmed]);
    spyStdio();
    const retried = yield* replacement.open(target, settings).pipe(Effect.result);
    expect(retried._tag).toBe(confirmed ? "Success" : "Failure");
  }),
);

it.effect("reuses a stdio era verdict for the same definition until an acquisition fails", () =>
  Effect.gen(function* () {
    const opened: Stdio.SdkStdioOptions[] = [];
    let fail = false;
    vi.spyOn(Stdio, "openSdkStdio").mockImplementation((options) => {
      opened.push(options);
      if (fail) return Effect.fail(boundaryError("protocol", "not-sent", "Stale verdict."));
      options.onNegotiated?.({ era: "modern", version: "2026-07-28" });
      return cleanupOnClose(options.onCleanup);
    });
    const connector = yield* makeConnector();
    const target = stdioServer("verdict");
    const openAndClose = connector.open(target, settings).pipe(
      Effect.flatMap((connection) => connection.close),
      Effect.scoped,
    );
    yield* openAndClose;
    yield* openAndClose;
    expect(opened.map((options) => options.remembered)).toEqual([
      undefined,
      { era: "modern", version: "2026-07-28" },
    ]);
    // A different definition never inherits another's verdict.
    yield* connector.open({ ...target, identity: "edited" }, settings).pipe(
      Effect.flatMap((connection) => connection.close),
      Effect.scoped,
    );
    expect(opened[2]?.remembered).toBeUndefined();
    fail = true;
    yield* openAndClose.pipe(Effect.flip);
    fail = false;
    yield* openAndClose;
    expect(opened[4]?.remembered).toBeUndefined();
  }),
);
