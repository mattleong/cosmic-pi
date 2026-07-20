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
import betterXai, {
  betterXaiWithDependencies,
  type BetterXaiExtensionDependencies,
} from "../src/extension.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = (args: string, ctx: ExtensionContext) => unknown;

function harness(dependencies?: BetterXaiExtensionDependencies) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-xai-project-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-better-xai-agent-"));
  tempDirectories.push(cwd, agentDir);
  const configDirectory = join(cwd, ".pi", "extensions");
  mkdirSync(configDirectory, { recursive: true });
  writeFileSync(
    join(configDirectory, "pi-better-xai.json"),
    '{"usage":{"enabled":false},"footer":{"mode":"status"}}\n',
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const notify = vi.fn();
  const setStatus = vi.fn();
  const setFooter = vi.fn();
  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
    },
    registerCommand(name: string, options: { handler: Command }) {
      commands.set(name, options.handler);
    },
    events: { emit: vi.fn(), on: vi.fn() },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    mode: "tui",
    hasUI: true,
    model: { provider: "xai", id: "grok" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyForProvider: () => Promise.resolve(undefined),
    },
    ui: { notify, setStatus, setFooter },
  } as unknown as ExtensionContext;

  if (dependencies) betterXaiWithDependencies(pi, dependencies);
  else betterXai(pi);
  return { handlers, commands, ctx, notify, setStatus, setFooter };
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

async function invoke(value: unknown) {
  await value;
}

describe("Better xAI Effect boundary", () => {
  test("serializes repeated starts, serves commands, and disposes idempotently", async () => {
    const h = harness();
    await invoke(h.handlers.get("session_start")?.({}, h.ctx));
    await invoke(h.handlers.get("session_start")?.({}, h.ctx));

    expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
    expect(h.setStatus).not.toHaveBeenCalled();
    expect(h.setFooter).not.toHaveBeenCalled();
    await invoke(h.commands.get("xai-usage")?.("", h.ctx));
    expect(h.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");

    await invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
    await invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
  });

  test("replacement immediately interrupts a stalled session startup", async () => {
    const stalled = stalledStartup();
    const h = harness({
      startupEffect: (generation) => (generation === 1 ? stalled.effect : Effect.void),
    });
    const first = h.handlers.get("session_start")?.({}, h.ctx);
    await stalled.started;

    const second = h.handlers.get("session_start")?.({}, h.ctx);
    await Promise.all([first, second]);

    expect(stalled.interruptions()).toBe(1);
    expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
    await invoke(h.commands.get("xai-usage")?.("", h.ctx));
    expect(h.notify).toHaveBeenCalledWith("Usage display is disabled.", "warning");
    await invoke(h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx));
  });

  test("host abort immediately interrupts a stalled session startup and removes its listener", async () => {
    const stalled = stalledStartup();
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness({ startupEffect: () => stalled.effect });
    h.ctx.signal = controller.signal;
    const startup = h.handlers.get("session_start")?.({}, h.ctx);
    await stalled.started;
    const hostAbortListener = addEventListener.mock.calls[0]?.[1];

    controller.abort();
    await startup;

    expect(stalled.interruptions()).toBe(1);
    expect(hostAbortListener).toBeTypeOf("function");
    expect(removeEventListener).toHaveBeenCalledWith("abort", hostAbortListener);
    expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
  });

  test("disposes and clears a runtime when startup is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    const removeEventListener = vi.spyOn(controller.signal, "removeEventListener");
    const h = harness();
    h.ctx.signal = controller.signal;

    await invoke(h.handlers.get("session_start")?.({}, h.ctx));

    expect(removeEventListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(h.notify).toHaveBeenCalledWith("Better xAI failed to start.", "warning");
    await invoke(h.commands.get("xai-usage")?.("", h.ctx));
    expect(h.notify).toHaveBeenCalledWith("xAI usage is unavailable.", "warning");
  });

  test("shutdown immediately interrupts a stalled session startup", async () => {
    const stalled = stalledStartup();
    const h = harness({ startupEffect: () => stalled.effect });
    const startup = h.handlers.get("session_start")?.({}, h.ctx);
    await stalled.started;

    const shutdown = h.handlers.get("session_shutdown")?.({ reason: "quit" }, h.ctx);
    await Promise.all([startup, shutdown]);

    expect(stalled.interruptions()).toBe(1);
    expect(h.notify).not.toHaveBeenCalledWith("Better xAI failed to start.", "warning");
  });
});
