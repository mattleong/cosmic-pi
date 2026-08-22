// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI, {
  betterOpenAIWithDependencies,
  type BetterOpenAIExtensionDependencies,
} from "../src/extension.ts";

type Handler = ExtensionHandler<any, any>;
type Command = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;
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
  const piFixture = {
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
  };
  // SAFETY: Better OpenAI registration uses only the ExtensionAPI methods implemented here.
  const pi = piFixture as typeof piFixture & ExtensionAPI;
  const contextFixture = {
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
      getBranch: () => [],
      buildContextEntries: () => [],
      getLeafId: () => null,
      getCwd: () => cwd,
      getSessionName: () => undefined,
    },
    getContextUsage: () => ({ contextWindow: 100, percent: 1 }),
    getSystemPrompt: () => "system",
    isProjectTrusted: vi.fn(() => true),
  };
  // SAFETY: This harness supplies every context member exercised by events and commands.
  const ctx = contextFixture as typeof contextFixture & ExtensionCommandContext;
  if (dependencies) betterOpenAIWithDependencies(pi, dependencies);
  else betterOpenAI(pi);
  const emit = async (name: string, event: any = {}, useCtx = ctx) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, useCtx);
  };
  return {
    ctx,
    handlers,
    commands,
    get tool() {
      return tool;
    },
    pi,
    emit,
  };
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

function deferredPromise() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Better OpenAI session boundary", () => {
  test("ignores an older session when settings loads complete out of order", async () => {
    const loads = [deferredPromise(), deferredPromise()];
    const started: number[] = [];
    let loadIndex = 0;
    const h = harness({
      loadPreviewSettings: () => loads[loadIndex++]!.promise,
      startupEffect: (generation) =>
        Effect.sync(() => {
          started.push(generation);
        }),
    });

    const first = h.emit("session_start");
    const second = h.emit("session_start");
    expect(loadIndex).toBe(2);

    loads[1]!.resolve();
    await second;
    loads[0]!.resolve();
    await first;

    expect(started).toEqual([2]);
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

  test("reports a success-path command defect instead of swallowing it", async () => {
    let resets = 0;
    const h = harness({
      startupEffect: () => Effect.void,
      resetOpenAICodexTransport: () => {
        resets++;
        if (resets > 1) throw new Error("transport reset defect");
      },
    });
    await h.emit("session_start");
    vi.mocked(h.ctx.ui.notify).mockClear();

    await expect(Promise.resolve(h.commands.get("fast")?.("", h.ctx))).resolves.toBeUndefined();

    expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.any(String), "warning");
    await h.emit("session_shutdown");
  });

  test("does not report image cancellation as message-delivery failure", async () => {
    const h = harness();
    writeFileSync(
      join(h.ctx.cwd, ".pi", "extensions", "pi-better-openai.json"),
      JSON.stringify({
        persistState: false,
        usage: { enabled: false },
        footer: { mode: "off" },
        image: { enabled: true },
      }),
    );
    await h.emit("session_start");
    const controller = new AbortController();
    controller.abort(new Error("cancel image"));
    h.ctx.signal = controller.signal;
    vi.mocked(h.ctx.ui.notify).mockClear();

    await expect(
      Promise.resolve(h.commands.get("openai-image")?.("cancelled prompt", h.ctx)),
    ).resolves.toBeUndefined();

    expect(h.ctx.ui.notify).not.toHaveBeenCalledWith(expect.any(String), "warning");
    await h.emit("session_shutdown");
  });

  test("keeps the replacement context current after deactivating the previous runtime", async () => {
    const h = harness();
    const configPath = join(h.ctx.cwd, ".pi", "extensions", "pi-better-openai.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        persistState: false,
        usage: { enabled: true, showOnlyOnSubscriptionModels: true },
        footer: { mode: "off" },
        image: { enabled: false },
      }),
    );
    await h.emit("session_start");
    const replacement = { ...h.ctx };
    await h.emit("session_start", {}, replacement);
    vi.mocked(h.ctx.ui.notify).mockClear();

    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const selected = {
      ...replacement,
      model: { ...replacement.model, provider: "anthropic", id: "claude" },
    };
    await h.emit("model_select", { model: selected.model }, selected);
    await Promise.resolve(h.commands.get("openai-usage")?.("", selected));

    expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(
      "Usage hidden: current model is not an OpenAI subscription model.",
      "warning",
    );
    await h.emit("session_shutdown", {}, selected);
  });

  test("fails closed when terminal UI capability getters throw during activation", async () => {
    const h = harness();
    Object.defineProperty(h.ctx, "mode", {
      configurable: true,
      get() {
        throw new Error("host mode unavailable");
      },
    });

    await expect(h.emit("session_start")).resolves.toBeUndefined();
    expect(h.ctx.ui.setFooter).not.toHaveBeenCalled();
    await expect(
      Promise.resolve(h.commands.get("openai-settings")?.("usage.enabled false", h.ctx)),
    ).resolves.toBeUndefined();
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
    expect(h.tool).toBeUndefined();
  });

  test("captures changing session cwd and signal getters exactly once", async () => {
    const h = harness();
    const controller = new AbortController();
    let cwdReads = 0;
    let signalReads = 0;
    const replacement = { ...h.ctx };
    Object.defineProperties(replacement, {
      cwd: {
        configurable: true,
        get() {
          cwdReads++;
          if (cwdReads > 1) throw new Error("cwd was read again");
          return h.ctx.cwd;
        },
      },
      signal: {
        configurable: true,
        get() {
          signalReads++;
          if (signalReads > 1) throw new Error("signal was read again");
          return controller.signal;
        },
      },
    });

    await expect(h.emit("session_start", {}, replacement)).resolves.toBeUndefined();

    expect(cwdReads).toBe(1);
    expect(signalReads).toBe(1);
    await expect(
      Promise.resolve(h.commands.get("openai-usage")?.("", h.ctx)),
    ).resolves.toBeUndefined();
    await h.emit("session_shutdown", {}, h.ctx);
  });

  test.each(["cwd", "signal"] as const)(
    "fails closed and deactivates the prior runtime when the session %s getter throws",
    async (property) => {
      const h = harness();
      await h.emit("session_start");
      vi.mocked(h.ctx.ui.notify).mockClear();
      const replacement = { ...h.ctx };
      Object.defineProperty(replacement, property, {
        configurable: true,
        get() {
          throw new Error(`${property} unavailable`);
        },
      });

      await expect(h.emit("session_start", {}, replacement)).resolves.toBeUndefined();

      expect(h.ctx.ui.notify).toHaveBeenCalledWith("Better OpenAI failed to start.", "warning");
      await expect(
        h.tool.execute("call", { prompt: "x" }, undefined, undefined, h.ctx),
      ).rejects.toThrow("has not started");
    },
  );

  test("materializes one dynamic signal for both model-change forks", async () => {
    const h = harness();
    await h.emit("session_start");
    let reads = 0;
    Object.defineProperty(h.ctx, "signal", {
      configurable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error("signal was read again");
        return undefined;
      },
    });

    await h.emit("model_select", {}, h.ctx);

    expect(reads).toBe(1);
    await h.emit("session_shutdown", {}, h.ctx);
  });
});
