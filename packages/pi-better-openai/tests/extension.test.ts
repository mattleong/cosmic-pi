// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, {
  betterOpenAIWithDependencies,
  type BetterOpenAIExtensionDependencies,
} from "../src/extension.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => unknown;
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

function harness(dependencies?: BetterOpenAIExtensionDependencies) {
  const cwd = mkdtempSync(join(tmpdir(), "openai-extension-"));
  const agentDir = mkdtempSync(join(tmpdir(), "openai-agent-"));
  directories.push(cwd, agentDir);
  mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "extensions", "pi-better-openai.json"),
    JSON.stringify({
      persistState: false,
      usage: { enabled: false },
      footer: { mode: "status" },
      image: { enabled: false },
    }),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, Command>();
  let tool: any;
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: { handler: Command }) {
      commands.set(name, options.handler);
    },
    registerFlag: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
    registerTool(value: any) {
      tool = value;
    },
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: true,
    model: { provider: "openai", id: "gpt-5.5" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setFooter: vi.fn() },
    sessionManager: {
      getEntries: () => [],
      getLeafId: () => null,
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: 100, percent: 1 }),
  } as unknown as ExtensionContext;
  if (dependencies) betterOpenAIWithDependencies(pi, dependencies);
  else betterOpenAI(pi);
  const emit = async (name: string, event: any = {}, useCtx = ctx) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, useCtx);
  };
  return { ctx, handlers, commands, tool, pi, emit };
}

function stalledStartup() {
  let signalStarted: (() => void) | undefined;
  let interruptions = 0;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const effect = Effect.sync(() => signalStarted?.()).pipe(
    Effect.andThen(Effect.never),
    Effect.ensuring(Effect.sync(() => void interruptions++)),
  );
  return { effect, started, interruptions: () => interruptions };
}

describe("Better OpenAI session boundary", () => {
  test("replaces repeated session runtimes, toggles fast mode, serves settings, and shuts down idempotently", async () => {
    const h = harness();
    const controller = new AbortController();
    h.ctx.signal = controller.signal;
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    await h.emit("session_start");
    await h.emit("session_start");
    expect(addListener.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(removeListener.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
    await h.commands.get("fast")?.("", h.ctx);
    const payload = { model: "gpt-5.5" };
    const results: unknown[] = [];
    for (const handler of h.handlers.get("before_provider_request") ?? [])
      results.push(await handler({ payload }, h.ctx));
    expect(results).toContainEqual({ model: "gpt-5.5", service_tier: "priority" });
    await h.commands.get("openai-settings")?.("usage.enabled false", h.ctx);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("usage.enabled = false"),
      "info",
    );
    await h.commands.get("openai-usage")?.("", h.ctx);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
    await h.emit("session_shutdown");
    expect(removeListener.mock.calls.length).toBeGreaterThanOrEqual(2);
    await h.emit("session_shutdown");
  });

  test("replacement immediately interrupts a stalled session startup", async () => {
    const stalled = stalledStartup();
    const h = harness({
      startupEffect: (generation) => (generation === 1 ? stalled.effect : Effect.void),
    });
    const first = h.emit("session_start");
    await stalled.started;

    const second = h.emit("session_start");
    await Promise.all([first, second]);

    expect(stalled.interruptions()).toBe(1);
    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
    await h.commands.get("openai-usage")?.("", h.ctx);
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
    await h.emit("session_shutdown");
  });

  test("host abort immediately interrupts a stalled startup and removes its listener", async () => {
    const stalled = stalledStartup();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ startupEffect: () => stalled.effect });
    h.ctx.signal = controller.signal;
    const startup = h.emit("session_start");
    await stalled.started;
    const hostAbortListener = addEventListener.mock.calls[0]?.[1];

    controller.abort(new Error("session replaced"));
    await startup;

    expect(stalled.interruptions()).toBe(1);
    expect(hostAbortListener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", hostAbortListener);
    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
    await expect(
      h.tool.execute("call", { prompt: "x" }, undefined, undefined, h.ctx),
    ).rejects.toThrow("has not started");
  });

  test("shutdown immediately interrupts a stalled session startup", async () => {
    const stalled = stalledStartup();
    const h = harness({ startupEffect: () => stalled.effect });
    const startup = h.emit("session_start");
    await stalled.started;

    const shutdown = h.emit("session_shutdown");
    await Promise.all([startup, shutdown]);

    expect(stalled.interruptions()).toBe(1);
    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
  });

  test("disposes and clears a runtime when startup is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    h.ctx.signal = controller.signal;
    await h.emit("session_start");
    expect(h.ctx.ui.notify).toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
    await expect(
      h.tool.execute("call", { prompt: "x" }, undefined, undefined, h.ctx),
    ).rejects.toThrow("has not started");
  });

  test("recomputes model visibility before asynchronous refresh and rejects disabled image work", async () => {
    const h = harness();
    await h.emit("session_start");
    h.ctx.model = { provider: "anthropic", id: "claude" } as ExtensionContext["model"];
    await h.emit("model_select", { model: h.ctx.model });
    expect(h.ctx.ui.setStatus).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("Usage:"),
    );
    await expect(
      h.tool.execute("call", { prompt: "verbatim" }, undefined, undefined, h.ctx),
    ).rejects.toThrow("disabled");
    await h.emit("session_shutdown");
  });
});
