import { it } from "@effect/vitest";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  extensionApiFixture,
  extensionContextFixture,
  opaqueFixture,
} from "pi-cosmic-core/testing";
import type { CompactAnimationScheduler } from "pi-code-previews";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { makeMcpLifecycle, type McpApplicationBoundaries } from "../src/application/lifecycle.ts";
import { registerMcpCommands } from "../src/settings/controller.ts";
import { mcpFailureReply } from "../src/boundary/host-tool-result.ts";
import { McpAuth } from "../src/auth/service.ts";
import { boundaryError, type McpBoundaryError } from "../src/client/errors.ts";
import { McpCodeModeOutputSchema, type McpCodeModeInput } from "../src/code-mode/protocol.ts";
import type { McpToolDefinition } from "../src/tools/controller.ts";
import type { McpGatewayExecution } from "../src/tools/model.ts";
import { McpExecution } from "../src/tools/service.ts";
import { decodeGatewayRequest } from "../src/invocation/validation.ts";
import { host, presentationLayer, queryCodeMode } from "./fixtures/application.ts";
import { fakeAuth, fakeConfigStore, testConfig } from "./fixtures/services.ts";

const rejects = <A>(
  run: () => Promise<A>,
  match: Pick<McpBoundaryError, "kind"> & Partial<Pick<McpBoundaryError, "outcome">>,
) => host(() => expect(run()).rejects.toMatchObject(match));
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

const harness = (
  options: {
    readonly cleanup?: () => Effect.Effect<void>;
    readonly acquire?: Effect.Effect<void, ReturnType<typeof boundaryError>>;
    readonly execute?: () => Effect.Effect<McpGatewayExecution, ReturnType<typeof boundaryError>>;
    readonly loadSettings?: McpApplicationBoundaries["loadSettings"];
    readonly wrapTool?: McpApplicationBoundaries["wrapTool"];
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
  const pi = extensionApiFixture({
    events,
    registerTool,
    getAllTools,
    getActiveTools: () => names,
    setActiveTools: vi.fn((next: string[]) => {
      names = next;
    }),
  });
  const ctx = extensionContextFixture({
    cwd: directory,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "session" },
    ui: { notify },
  });
  const lifecycle = makeMcpLifecycle(pi, {
    loadSettings: options.loadSettings ?? (() => Promise.resolve()),
    wrapTool: options.wrapTool ?? ((definition) => definition),
    makeLayer: (input) => {
      return Layer.mergeAll(
        presentationLayer,
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
              };
            }),
            () =>
              Effect.gen(function* () {
                released++;
                if (options.cleanup) yield* options.cleanup();
              }),
          ),
        ),
        fakeConfigStore(testConfig({ trusted: input.projectTrusted })).layer,
        Layer.succeed(McpAuth, fakeAuth()),
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
      tool = opaqueFixture({ name: "mcp", description: "foreign" });
      source = "foreign";
      names.push("mcp");
    },
    query: (sessionId = "session") => queryCodeMode(events, sessionId),
  };
};

const encodeOutput = Schema.encodeEffect(Schema.fromJsonString(McpCodeModeOutputSchema));

const parity = (
  error: ReturnType<typeof boundaryError>,
  input: McpCodeModeInput & Parameters<McpToolDefinition["execute"]>[1],
  budget: number,
) =>
  Effect.gen(function* () {
    const h = harness({ execute: () => Effect.fail(error) });
    yield* host(() => h.lifecycle.start(h.ctx));
    const signal = yield* Effect.abortSignal;
    const provider = h.query()[0]!;
    const gateway = yield* host(() => h.tool.execute("gateway", input, signal, undefined, h.ctx));
    const nested = yield* host(() => provider.execute("nested", input, signal, budget));
    expect(nested).toEqual(gateway.details);
    expect(yield* encodeOutput(nested)).not.toContain("private-");
    expect(nested.resultId).toBeUndefined();
    const revoked = Effect.gen(function* () {
      yield* host(() => h.lifecycle.shutdown());
      yield* rejects(() => provider.execute("stale", input, signal, budget), {
        kind: "unavailable",
        outcome: "not-sent",
      });
    });
    return { provider, nested, signal, revoked };
  });

describe("MCP session ownership", () => {
  it.live("owns animation ticks until replacement and rejects stale scheduling", () =>
    Effect.gen(function* () {
      const schedulers: CompactAnimationScheduler[] = [];
      const h = harness({
        wrapTool: (tool, schedule) => {
          schedulers.push(schedule);
          return tool;
        },
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      let oldTicks = 0;
      const firstTick = yield* Deferred.make<void>();
      expect(
        schedulers[0]!(10, () => {
          oldTicks++;
          Deferred.doneUnsafe(firstTick, Effect.void);
          return true;
        }),
      ).toBeTypeOf("function");
      yield* Deferred.await(firstTick);
      yield* host(() => h.lifecycle.start(h.ctx));
      const stopped = oldTicks;
      expect(schedulers[0]!(10, () => true)).toBeUndefined();
      let replacementTicks = 0;
      const nextTick = yield* Deferred.make<void>();
      expect(
        schedulers[1]!(10, () => {
          replacementTicks++;
          Deferred.doneUnsafe(nextTick, Effect.void);
          return true;
        }),
      ).toBeTypeOf("function");
      yield* Deferred.await(nextTick);
      expect(oldTicks).toBe(stopped);
      yield* host(() => h.lifecycle.shutdown());
      expect(schedulers[1]!(10, () => true)).toBeUndefined();
      const shutdownTicks = replacementTicks;
      yield* Effect.sleep("30 millis");
      expect(replacementTicks).toBe(shutdownTicks);
    }),
  );
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

  it.live("withholds completed output cancelled between execution and host publication", () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const h = harness({
        execute: () =>
          Effect.sync(() => {
            // Execution settles first; cancellation precedes the host Promise continuation.
            queueMicrotask(() => controller.abort());
            return {
              reply: {
                action: "tools.call",
                outcome: "completed" as const,
                isError: false,
                data: { private: "completed payload" },
                resultId: "retained-private-output",
                notices: [],
              },
              images: [{ type: "image" as const, data: "private-image", mimeType: "image/png" }],
            };
          }),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      try {
        const result = yield* host(() =>
          h.tool.execute("cancelled-publication", {}, controller.signal, undefined, h.ctx),
        );
        expect(controller.signal.aborted).toBe(true);
        expect(result.details).toMatchObject({ outcome: "completed", isError: true });
        expect(result.details?.resultId).toBeUndefined();
        expect(Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(result)).not.toContain(
          "private",
        );
        expect(result.content.some((item) => item.type === "image")).toBe(false);
      } finally {
        yield* host(() => h.lifecycle.shutdown());
      }
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
      yield* rejects(() => old.execute("stale", { action: "status" }, signal, 2_000), {
        kind: "unavailable",
        outcome: "not-sent",
      });
      yield* Deferred.await(cleaning);
      expect(h.counts).toEqual({ acquired: 1, released: 1 });
      yield* Deferred.succeed(release, undefined);
      yield* host(() => replacement);
      expect(h.query()).toHaveLength(1);
      yield* rejects(() => oldTool.execute("stale", {}, undefined, undefined, h.ctx), {
        kind: "stale",
      });
      yield* host(() => h.lifecycle.shutdown());
      yield* host(() => h.lifecycle.shutdown());
      expect(h.counts).toEqual({ acquired: 2, released: 2 });
    }),
  );

  it.live("preserves the instructions action when the gateway reports a failure", () =>
    Effect.gen(function* () {
      const h = harness({
        execute: () => Effect.fail(boundaryError("auth-required", "not-sent", "private-failure")),
      });
      yield* host(() => h.lifecycle.start(h.ctx));
      const gateway = yield* host(() =>
        h.tool.execute(
          "instructions",
          { action: "server.instructions", server: "one" },
          undefined,
          undefined,
          h.ctx,
        ),
      );
      expect(gateway.details).toMatchObject({
        action: "server.instructions",
        outcome: "not-sent",
        isError: true,
        data: { kind: "auth-required" },
      });
      yield* host(() => h.lifecycle.shutdown());
    }),
  );

  it.live("shares bounded auth recovery and certainty between gateway and Code Mode", () =>
    Effect.gen(function* () {
      const reason = "auth-not-configured";
      const input = { action: "tools.search", server: "one", query: "private-query" } as const;
      for (const outcome of ["not-sent", "completed", "unknown"] as const) {
        const { provider, nested, signal, revoked } = yield* parity(
          boundaryError("auth-required", outcome, "private-credential", reason),
          input,
          2_000,
        );
        expect(nested).toMatchObject({
          action: "tools.search",
          outcome,
          isError: true,
          data: { kind: "auth-required", reason },
        });
        if (outcome === "unknown") expect(nested.notices.join(" ")).toMatch(/Do not replay/);
        yield* rejects(() => provider.execute("bounded", input, signal, 1), {
          kind: "output-limit",
          outcome,
        });
        yield* revoked;
      }
    }),
  );

  it.live("preserves refresh context and auth guidance through the user command handler", () =>
    Effect.gen(function* () {
      const error = boundaryError(
        "auth-required",
        "unknown",
        "private-failure",
        "auth-not-configured",
      );
      const h = harness({ execute: () => Effect.fail(error) });
      yield* host(() => h.lifecycle.start(h.ctx));
      const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
      registerMcpCommands(
        {
          ...h.pi,
          registerCommand: (name, command) => {
            commands.set(name, command);
          },
        },
        h.lifecycle.commands,
      );
      const ctx = { ...h.ctx, mode: "rpc" as const };
      yield* host(() => Promise.resolve(commands.get("mcp")!.handler("refresh one", ctx)));
      const notification = h.notify.mock.calls.at(-1)?.[0];
      const expected = mcpFailureReply("refresh", error);
      expect(notification).toBe(yield* encodeOutput(expected));
      expect(notification).not.toContain("private-failure");
      yield* host(() => h.lifecycle.shutdown());
    }),
  );

  it.live("labels rejected gateway input generically without evaluating an action getter", () =>
    Effect.gen(function* () {
      let reads = 0;
      const getter = {
        get action() {
          reads += 1;
          return "status" as const;
        },
        server: "private-value",
      };
      for (const request of [{ action: "PRIVATE_ACTION", server: "private-value" }, getter]) {
        const h = harness({
          execute: () =>
            decodeGatewayRequest(request).pipe(
              Effect.andThen(Effect.die("Invalid request was admitted")),
            ),
        });
        yield* host(() => h.lifecycle.start(h.ctx));
        // SAFETY: Intentionally malformed input exercises the public gateway's rejection path.
        const input = request as Parameters<McpToolDefinition["execute"]>[1];
        const result = yield* host(() =>
          h.tool.execute("invalid", input, undefined, undefined, h.ctx),
        );
        expect(result.details).toMatchObject({ outcome: "not-sent", isError: true });
        if (request !== getter) {
          const guidance = result.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join(" ");
          expect(guidance).toContain("supported MCP action");
          expect(guidance).not.toContain("Status accepts only action");
          expect(guidance).not.toContain("PRIVATE_ACTION");
          expect(guidance).not.toContain("private-value");
        }
        yield* host(() => h.lifecycle.shutdown());
      }
      expect(reads).toBe(0);
    }),
  );

  it.live("shares fixed prompt argument hints between gateway and Code Mode", () =>
    Effect.gen(function* () {
      const { nested, revoked } = yield* parity(
        boundaryError("invalid-input", "not-sent", "private-argument-value"),
        { action: "prompts.get", server: "one", prompt: "private-prompt-name" },
        512,
      );
      expect(nested).toMatchObject({
        action: "prompts.get",
        outcome: "not-sent",
        isError: true,
        data: { kind: "invalid-input" },
      });
      expect(nested.notices.join(" ")).toMatch(/prompts\.list.*same server.*arguments/);
      yield* revoked;
    }),
  );

  it.live.each(["completed", "unknown"] as const)(
    "does not convert a %s prompt failure into a local argument hint",
    (outcome) =>
      Effect.gen(function* () {
        const h = harness({
          execute: () => Effect.fail(boundaryError("invalid-input", outcome, "private-failure")),
        });
        yield* host(() => h.lifecycle.start(h.ctx));
        const signal = yield* Effect.abortSignal;
        const input = { action: "prompts.get", server: "one", prompt: "example" } as const;
        yield* rejects(() => h.query()[0]!.execute("remote", input, signal, 512), {
          kind: "invalid-input",
          outcome,
        });
        const gateway = yield* host(() =>
          h.tool.execute("remote", input, signal, undefined, h.ctx),
        );
        expect(gateway.details?.notices.join(" ")).not.toContain("prompts.list");
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
