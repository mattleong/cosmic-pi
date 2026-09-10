import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, vi } from "vitest";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
const serialize = <Value>(value: Value) => JSON.stringify(value);
import { McpAuth } from "../src/auth/service.ts";
import { McpAuthFlow } from "../src/auth/flow.ts";
import { McpManager } from "../src/manager/service.ts";
import { makeMcpLoginUi } from "../src/boundary/host-auth.ts";
import { boundaryError } from "../src/client/errors.ts";
import { DEFAULT_MCP_SETTINGS } from "../src/config/schema.ts";
import type { McpConfigStoreContract, McpResolvedConfig } from "../src/config/model.ts";
import { McpConfigStore } from "../src/config/store.ts";
import {
  mcpConfigMetadata,
  mcpSettingsCompletions,
  runMcpSettingsCommand,
  runMcpUserCommand,
} from "../src/settings/controller.ts";
import { McpExecution } from "../src/tools/service.ts";

const secret = "not-for-model-callback-code";
const config: McpResolvedConfig = {
  revision: 1,
  trusted: true,
  settings: DEFAULT_MCP_SETTINGS,
  diagnostics: [secret],
  servers: {
    fixture: {
      id: "fixture",
      enabled: true,
      scope: "global",
      directory: `/private/${secret}`,
      identity: secret,
      definition: {
        transport: "http",
        url: `https://mcp.example/${secret}`,
        headers: { Authorization: secret },
        auth: { type: "none" },
        denyTools: [],
      },
      diagnostic: secret,
    },
  },
};
type CommandContextFixture = Pick<ExtensionContext, "mode" | "hasUI" | "isProjectTrusted"> & {
  readonly ui: Pick<ExtensionContext["ui"], "input" | "confirm" | "notify">;
};
const context = (mode: ExtensionContext["mode"] = "tui", trusted = true): ExtensionContext => {
  const value: CommandContextFixture = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    isProjectTrusted: () => trusted,
    ui: { input: vi.fn(), confirm: vi.fn(() => Promise.resolve(true)), notify: vi.fn() },
  };
  // SAFETY: This partial fixture supplies exactly the host fields consumed by commands and login UI.
  return value as ExtensionContext;
};
// SAFETY: The auth boundary uses only the public exec capability, which this fixture supplies.
const hostWithExec = (exec: ExtensionAPI["exec"]): ExtensionAPI => ({ exec }) as ExtensionAPI;
const makeStore = () => {
  const store: McpConfigStoreContract = {
    snapshot: Effect.succeed(config),
    reload: Effect.succeed(config),
    subscribe: () => Effect.void,
    setServer: vi.fn(() => Effect.succeed(config)),
    removeServer: vi.fn(() => Effect.succeed(config)),
    setSettings: vi.fn(() => Effect.succeed(config)),
  };
  return store;
};

describe("MCP settings completion", () => {
  const values = (prefix: string) =>
    mcpSettingsCompletions(prefix)?.map((item) => item.value) ?? null;

  it("completes actions and filters partially entered names", () => {
    expect(values("")).toEqual(["show", "reload", "set-server", "remove-server", "set-settings"]);
    expect(values("set-s")).toEqual(["set-server", "set-settings"]);
    expect(values("rel")).toEqual(["reload"]);
  });

  it.each(["set-server", "remove-server", "set-settings"])(
    "completes scopes for %s using the full argument prefix",
    (action) => {
      expect(values(`${action} `)).toEqual([`${action} global`, `${action} project`]);
      expect(values(`${action} p`)).toEqual([`${action} project`]);
      expect(values(`${action}\t g`)).toEqual([`${action} global`]);
      expect(values(`${action} global `)).toBeNull();
    },
  );

  it.each([
    "unknown",
    "show ",
    "reload p",
    "set-server unknown",
    "set-server global server ",
    'set-settings project {"enabled":',
    "x".repeat(257),
  ])("does not complete unsupported syntax or payloads: %s", (prefix) => {
    expect(values(prefix)).toBeNull();
  });
});

describe("MCP argument-first commands", () => {
  it.effect("passes JSON to the single config persistence API and shows only metadata", () =>
    Effect.gen(function* () {
      const store = makeStore();
      const layer = Layer.succeed(McpConfigStore, store);
      const ctx = context();
      for (const command of [
        `set-server project fixture {"url":"https://example.test","headers":{"Authorization":"${secret}"}}`,
        'set-settings global {"enabled":false}',
        "remove-server project fixture",
        "reload",
        "show",
      ]) {
        const result = yield* runMcpSettingsCommand(command, ctx, () => true).pipe(
          Effect.provide(layer),
        );
        expect(serialize(result)).not.toContain(secret);
      }
      expect(store.setServer).toHaveBeenCalledWith(
        "project",
        "fixture",
        expect.objectContaining({ headers: { Authorization: secret } }),
      );
      expect(store.setSettings).toHaveBeenCalledWith("global", { enabled: false });
      expect(store.removeServer).toHaveBeenCalledWith("project", "fixture");
      expect(mcpConfigMetadata(config)).toMatchObject({
        servers: [{ id: "fixture", scope: "global", transport: "http" }],
      });
    }),
  );

  it.effect(
    "rejects malformed JSON, extra fields, stale commands and untrusted writes without exposing input",
    () =>
      Effect.gen(function* () {
        const store = makeStore();
        const layer = Layer.succeed(McpConfigStore, store);
        for (const command of [
          `set-server global fixture {${secret}`,
          `remove-server global fixture ${secret}`,
          "set-settings unknown {}",
        ]) {
          const result = yield* Effect.result(
            runMcpSettingsCommand(command, context(), () => true),
          ).pipe(Effect.provide(layer));
          expect(result._tag).toBe("Failure");
          expect(serialize(result)).not.toContain(secret);
        }
        for (const [ctx, current] of [
          [context("tui", false), () => true],
          [context(), () => false],
        ] as const) {
          const result = yield* Effect.result(
            runMcpSettingsCommand("set-settings global {}", ctx, current),
          ).pipe(Effect.provide(layer));
          expect(result._tag).toBe("Failure");
        }
        expect(store.setServer).not.toHaveBeenCalled();
        expect(store.setSettings).not.toHaveBeenCalled();
        expect(store.removeServer).not.toHaveBeenCalled();
      }),
  );

  for (const mode of ["print", "json"] as const)
    it.effect(`never opens authentication UI in ${mode} mode`, () =>
      Effect.gen(function* () {
        const login = vi.fn(() => Effect.succeed({ state: "ready" as const }));
        let ready = false;
        const forbidden = Effect.die("Headless auth opened interactive presentation");
        const layer = Layer.mergeAll(
          Layer.succeed(McpAuthFlow, {
            snapshot: () => undefined,
            subscribe: () => forbidden,
            run: () => forbidden,
          }),
          Layer.succeed(McpManager, {
            withView: () => forbidden,
            refresh: forbidden,
            snapshot: () => ({
              revision: 0,
              trusted: false,
              enabled: false,
              active: 0,
              queued: 0,
              servers: [],
            }),
            subscribe: () => forbidden,
            capture: () => forbidden,
            check: () => forbidden,
            dispatch: () => forbidden,
            cached: () => forbidden,
            cachedDetail: () => forbidden,
          }),
          Layer.succeed(McpExecution, {
            execute: () => Effect.fail(boundaryError("unsupported", "not-sent", "unused")),
            login,
            logout: () => Effect.void,
            available: Effect.succeed(true),
            isAvailable: () => true,
          }),
          Layer.succeed(McpConfigStore, makeStore()),
          Layer.succeed(McpAuth, {
            access: () =>
              ready
                ? Effect.succeed(secret)
                : Effect.fail(boundaryError("auth-required", "not-sent", secret)),
            status: () => Effect.succeed({ state: "required" }),
            login,
            logout: () => Effect.void,
            revoke: Effect.void,
            reject: () => Effect.void,
            completeLogin: () => Effect.void,
            finalizationFailed: () => Effect.void,
          }),
        );
        const ctx = context(mode);
        const pi = hostWithExec(vi.fn());
        const denied = yield* Effect.result(
          runMcpUserCommand("auth fixture", pi, ctx, () => true),
        ).pipe(Effect.provide(layer));
        expect(denied).toMatchObject({
          _tag: "Failure",
          failure: { kind: "unavailable", outcome: "not-sent" },
        });
        expect(serialize(denied)).not.toContain(secret);
        ready = true;
        expect(
          yield* runMcpUserCommand("auth fixture", pi, ctx, () => true).pipe(Effect.provide(layer)),
        ).toMatchObject({ isError: false, data: { state: "ready" } });
        expect(login).not.toHaveBeenCalled();
        expect(ctx.ui.input).not.toHaveBeenCalled();
        expect(pi.exec).not.toHaveBeenCalled();
      }),
    );

  it.effect(
    "keeps manual callbacks in a signal-owned user dialog and rejects unsafe browser schemes",
    () =>
      Effect.gen(function* () {
        let dialogSignal: AbortSignal | undefined;
        const entered = yield* Deferred.make<void>();
        const ctx = context("rpc");
        ctx.ui.input = vi.fn((_title, _placeholder, options) => {
          dialogSignal = options?.signal;
          Deferred.doneUnsafe(entered, Effect.void);
          return Effect.runPromise(
            Effect.never,
            options?.signal ? { signal: options.signal } : undefined,
          );
        });
        const pi = hostWithExec(
          vi.fn(() => Promise.resolve({ code: 0, killed: false, stdout: "", stderr: "" })),
        );
        const ui = makeMcpLoginUi(pi, ctx, true, () => true);
        yield* ui.openBrowser("https://auth.example/authorize?state=private");
        expect(pi.exec).not.toHaveBeenCalled();
        const waiting = yield* Effect.forkChild(ui.readCallback("https://auth.example/authorize"));
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(waiting);
        expect(dialogSignal?.aborted).toBe(true);
        const unsafe = yield* Effect.result(ui.openBrowser("file:///private/key"));
        expect(unsafe).toMatchObject({ _tag: "Failure", failure: { kind: "denied" } });
        expect(pi.exec).not.toHaveBeenCalled();
      }),
  );

  it.effect("uses only fixed macOS browser executable and URL argv after validation", () =>
    Effect.gen(function* () {
      const ctx = context();
      const exec = vi.fn(() => Promise.resolve({ code: 0, killed: false, stdout: "", stderr: "" }));
      const pi = hostWithExec(exec);
      const ui = makeMcpLoginUi(pi, ctx, false, () => true);
      if (process.platform === "darwin") {
        yield* ui.openBrowser("https://auth.example/authorize");
        expect(exec).toHaveBeenCalledWith(
          "/usr/bin/open",
          ["https://auth.example/authorize"],
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      }
      const revoked = makeMcpLoginUi(pi, ctx, false, () => false);
      expect(
        yield* Effect.result(revoked.openBrowser("https://auth.example/authorize")),
      ).toMatchObject({ _tag: "Failure", failure: { kind: "stale" } });
    }),
  );
});
