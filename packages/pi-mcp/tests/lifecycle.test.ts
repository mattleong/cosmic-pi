import { it } from "@effect/vitest";
import {
  createEventBus,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { makeMcpLifecycle, type McpApplicationBoundaries } from "../src/application/lifecycle.ts";
import { McpAuth } from "../src/auth/service.ts";
import { boundaryError } from "../src/client/errors.ts";
import { MCP_CODE_MODE_QUERY, type McpCodeModeCapability } from "../src/code-mode/protocol.ts";
import { DEFAULT_MCP_SETTINGS } from "../src/config/schema.ts";
import { McpConfigStore } from "../src/config/store.ts";
import type { McpToolDefinition } from "../src/tools/controller.ts";
import type { McpGatewayExecution } from "../src/tools/model.ts";
import { McpExecution } from "../src/tools/service.ts";

const host = <A>(run: () => PromiseLike<A>) => Effect.tryPromise(run);
let directory: string;
beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      directory = yield* fs.makeTempDirectory({ prefix: "pi-mcp-lifecycle-" });
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  ),
);
afterEach(() => {
  vi.unstubAllEnvs();
  return Effect.runPromise(
    FileSystem.FileSystem.use((fs) => fs.remove(directory, { recursive: true, force: true })).pipe(
      Effect.provide(nodeFilePlatformLayer),
    ),
  );
});

type LifecycleHostFixture = Pick<
  ExtensionAPI,
  "events" | "getAllTools" | "getActiveTools" | "setActiveTools"
> & { readonly registerTool: (tool: McpToolDefinition) => void };
type LifecycleContextFixture = Pick<
  ExtensionContext,
  "cwd" | "mode" | "hasUI" | "isProjectTrusted"
> & {
  readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId">;
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};
const harness = (
  options: {
    readonly cleanup?: () => Effect.Effect<void>;
    readonly acquire?: Effect.Effect<void, ReturnType<typeof boundaryError>>;
    readonly execute?: () => Effect.Effect<McpGatewayExecution, ReturnType<typeof boundaryError>>;
    readonly loadSettings?: McpApplicationBoundaries["loadSettings"];
  } = {},
) => {
  let trusted = true;
  let enabled = true;
  let source = "owned";
  let names = ["read"];
  let tool: McpToolDefinition | undefined;
  let acquired = 0;
  let released = 0;
  const events = createEventBus();
  const notify = vi.fn();
  const registerTool = vi.fn((definition: McpToolDefinition) => {
    tool = definition;
    source = "owned";
  });
  const getAllTools = vi.fn<ExtensionAPI["getAllTools"]>(() =>
    tool
      ? [
          {
            name: "mcp",
            description: tool.description,
            parameters: tool.parameters,
            sourceInfo: { path: source, source, scope: "user", origin: "top-level" },
          },
        ]
      : [],
  );
  const hostFixture: LifecycleHostFixture = {
    events,
    registerTool,
    getAllTools,
    getActiveTools: () => names,
    setActiveTools: vi.fn((next: string[]) => {
      names = next;
    }),
  };
  const contextFixture: LifecycleContextFixture = {
    cwd: directory,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "session" },
    ui: { notify },
  };
  // SAFETY: This controlled partial host implements every callback exercised by the lifecycle.
  const pi = hostFixture as ExtensionAPI;
  // SAFETY: This controlled partial context implements every field read by the lifecycle.
  const ctx = contextFixture as ExtensionContext;
  const lifecycle = makeMcpLifecycle(pi, {
    loadSettings: options.loadSettings ?? (() => Promise.resolve()),
    wrapTool: (definition) => definition,
    makeLayer: (input) => {
      const config = {
        revision: 1,
        trusted: input.projectTrusted,
        settings: DEFAULT_MCP_SETTINGS,
        servers: {},
        diagnostics: [],
      };
      return Layer.mergeAll(
        Layer.effect(
          McpExecution,
          Effect.acquireRelease(
            Effect.gen(function* () {
              if (options.acquire) yield* options.acquire;
              acquired++;
              return {
                execute:
                  options.execute ??
                  (() =>
                    Effect.succeed({
                      reply: {
                        action: "status",
                        outcome: "completed" as const,
                        isError: false,
                        data: { trusted: input.isTrusted() },
                        notices: [],
                      },
                      images: [],
                    })),
                login: () => Effect.succeed({ state: "ready" as const }),
                logout: () => Effect.void,
                isAvailable: () => input.projectTrusted && enabled && input.isTrusted(),
                available: Effect.sync(() => input.projectTrusted && enabled && input.isTrusted()),
              };
            }),
            () =>
              Effect.gen(function* () {
                released++;
                if (options.cleanup) yield* options.cleanup();
              }),
          ),
        ),
        Layer.succeed(McpConfigStore, {
          snapshot: Effect.succeed(config),
          subscribe: () => Effect.void,
          reload: Effect.succeed(config),
          setServer: () => Effect.succeed(config),
          removeServer: () => Effect.succeed(config),
          setSettings: () => Effect.succeed(config),
        }),
        Layer.succeed(McpAuth, {
          access: () => Effect.succeed(undefined),
          status: () => Effect.succeed({ state: "none" }),
          login: () => Effect.succeed({ state: "ready" }),
          logout: () => Effect.void,
          revoke: Effect.void,
        }),
      );
    },
  });
  return {
    lifecycle,
    ctx,
    pi,
    notify,
    registerTool,
    getAllTools,
    get tool() {
      if (!tool) throw new Error("MCP tool is not registered");
      return tool;
    },
    get counts() {
      return { acquired, released };
    },
    trust: (value: boolean) => {
      trusted = value;
    },
    enable: (value: boolean) => {
      enabled = value;
    },
    deactivate: () => {
      names = names.filter((name) => name !== "mcp");
    },
    foreign: () => {
      // SAFETY: A conflicting tool is inspected only for its name and provenance, never executed.
      tool = { name: "mcp", description: "foreign" } as McpToolDefinition;
      source = "foreign";
      names.push("mcp");
    },
    query: (sessionId = "session") => {
      const replies: McpCodeModeCapability[] = [];
      events.emit(MCP_CODE_MODE_QUERY, {
        version: 1,
        sessionId,
        respond: (capability: McpCodeModeCapability) => replies.push(capability),
      });
      return replies;
    },
  };
};

describe("MCP session ownership", () => {
  it.live("recovers after a failed layer acquisition without publishing stale authority", () =>
    Effect.gen(function* () {
      let failed = true;
      const h = harness({
        acquire: Effect.suspend(() =>
          failed
            ? Effect.fail(boundaryError("config", "not-sent", "fixture failure"))
            : Effect.void,
        ),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      expect(h.lifecycle.commands.capture(h.ctx)()).toBe(false);
      expect(h.query()).toEqual([]);
      expect(h.counts).toEqual({ acquired: 0, released: 0 });
      failed = false;
      yield* host(() => h.lifecycle.start(h.ctx));
      expect(h.query()).toHaveLength(1);
      yield* host(() => h.lifecycle.shutdown());
      expect(h.counts).toEqual({ acquired: 1, released: 1 });
    }),
  );

  it.live("suppresses a completed old-session reply that settles after revocation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const h = harness({
        execute: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return {
              reply: {
                action: "status",
                outcome: "completed" as const,
                isError: true,
                data: { stale: true },
                notices: [],
              },
              images: [],
            };
          }).pipe(Effect.uninterruptible),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      const pending = h.tool.execute("old", {}, undefined, undefined, h.ctx);
      const checked = expect(pending).rejects.toMatchObject({ kind: "stale" });
      yield* Deferred.await(entered);
      const replacement = h.lifecycle.start(h.ctx);
      expect(h.query()).toEqual([]);
      yield* Deferred.succeed(release, undefined);
      yield* host(() => checked);
      yield* host(() => replacement);
      expect(h.query()).toHaveLength(1);
      yield* host(() => h.lifecycle.shutdown());
    }),
  );

  it.live("defers resources to startup and leaves a foreign mcp untouched", () =>
    Effect.gen(function* () {
      const h = harness();
      expect(h.counts.acquired).toBe(0);
      h.foreign();
      yield* host(() => h.lifecycle.start(h.ctx));
      expect(h.counts.acquired).toBe(0);
      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.pi.setActiveTools).not.toHaveBeenCalled();
      expect(h.query()).toEqual([]);
      expect(h.notify).toHaveBeenCalled();
      yield* host(() => h.lifecycle.shutdown());
    }),
  );

  it.live(
    "allows local status untrusted, while capability discovery follows live trust, enabled and activation",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.trust(false);
        yield* host(() => h.lifecycle.start(h.ctx));
        const result = yield* host(() => h.tool.execute("status", {}, undefined, undefined, h.ctx));
        expect(result.details).toMatchObject({ isError: false, data: { trusted: false } });
        expect(h.query()).toEqual([]);
        h.trust(true);
        yield* host(() => h.lifecycle.start(h.ctx));
        expect(h.query()).toHaveLength(1);
        expect(h.query("wrong-session")).toEqual([]);
        h.trust(false);
        expect(h.query()).toEqual([]);
        h.trust(true);
        h.enable(false);
        expect(h.query()).toEqual([]);
        h.enable(true);
        h.deactivate();
        expect(h.query()).toEqual([]);
        yield* host(() => h.lifecycle.start(h.ctx));
        expect(h.query()).toEqual([]);
        yield* host(() => h.lifecycle.shutdown());
        expect(h.counts).toEqual({ acquired: 3, released: 3 });
      }),
  );

  it.live("revokes old capabilities before replacement cleanup finishes", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      let cleanupCount = 0;
      const h = harness({
        cleanup: () =>
          Effect.gen(function* () {
            if (++cleanupCount === 1) {
              yield* Deferred.succeed(cleaning, undefined);
              yield* Deferred.await(release);
            }
          }),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      const old = h.query()[0]!;
      const oldTool = h.tool;
      const replacement = h.lifecycle.start(h.ctx);
      expect(h.query()).toEqual([]);
      const signal = yield* Effect.abortSignal;
      yield* host(() =>
        expect(old.execute("stale", { action: "status" }, signal, 2_000)).rejects.toMatchObject({
          kind: "unavailable",
          outcome: "not-sent",
        }),
      );
      yield* Deferred.await(cleaning);
      expect(h.counts).toEqual({ acquired: 1, released: 1 });
      yield* Deferred.succeed(release, undefined);
      yield* host(() => replacement);
      expect(h.query()).toHaveLength(1);
      yield* host(() =>
        expect(oldTool.execute("stale", {}, undefined, undefined, h.ctx)).rejects.toMatchObject({
          kind: "stale",
        }),
      );
      yield* host(() => h.lifecycle.shutdown());
      yield* host(() => h.lifecycle.shutdown());
      expect(h.counts).toEqual({ acquired: 2, released: 2 });
    }),
  );

  it.live("retains typed certainty through the runtime-to-Code-Mode boundary", () =>
    Effect.gen(function* () {
      const h = harness({
        execute: () => Effect.fail(boundaryError("output-limit", "completed", "bounded")),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      const signal = yield* Effect.abortSignal;
      yield* host(() =>
        expect(
          h.query()[0]!.execute("failed", { action: "status" }, signal, 2_000),
        ).rejects.toMatchObject({ kind: "output-limit", outcome: "completed" }),
      );
      yield* host(() => h.lifecycle.shutdown());
    }),
  );

  it.live("does not install after superseded preview loading and removes the host listener", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      const h = harness({
        loadSettings: (_cwd, _trusted, signal) => {
          Deferred.doneUnsafe(entered, Effect.void);
          return Effect.runPromise(Effect.never, { signal }).catch(() => {
            Deferred.doneUnsafe(cancelled, Effect.void);
          });
        },
      });
      const starting = h.lifecycle.start(h.ctx);
      yield* Deferred.await(entered);
      const stopping = h.lifecycle.shutdown();
      yield* Deferred.await(cancelled);
      yield* host(() => Promise.all([starting, stopping]));
      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.query()).toEqual([]);
      expect(h.counts).toEqual({ acquired: 1, released: 1 });
    }),
  );

  it.live("fails closed if tool discovery throws after preview setup", () =>
    Effect.gen(function* () {
      const h = harness({
        loadSettings: () => {
          h.getAllTools.mockImplementation(() => {
            throw new Error("host unavailable");
          });
          return Promise.resolve();
        },
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      expect(h.registerTool).not.toHaveBeenCalled();
      expect(h.query()).toEqual([]);
      yield* host(() => h.lifecycle.shutdown());
      expect(h.counts).toEqual({ acquired: 1, released: 1 });
    }),
  );
});
