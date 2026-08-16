// Session-runtime lifecycle depth: exact acquisition/release, abort-listener cleanup, and
// no stale snapshots. Pi host callbacks are Promise-shaped boundaries.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import { makeLifecycleProbe } from "pi-cosmic-core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCodeModeApplication } from "../src/application.ts";
import { CodeModeConfigStore, type CodeModeState } from "../src/config/store.ts";
import {
  makeCodeModeLayer,
  type CodeModeApplication,
  type CodeModeRuntimeError,
  type CodeModeSessionInput,
} from "../src/layer.ts";
import { extensionApiFixture, extensionContextFixture } from "./support/host.ts";

const tempDirectories: string[] = [];
afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  delete process.env.PI_CODING_AGENT_DIR;
});

const newDirectory = (prefix: string): string => {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

const piStub = (): ExtensionAPI =>
  extensionApiFixture({
    on: vi.fn(),
    registerCommand: vi.fn(),
    registerTool: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn() },
  });

// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const sessionInput = (cwd: string): CodeModeSessionInput => ({
  ctx: extensionContextFixture({ cwd }),
  cwd,
  projectTrusted: true,
});

describe("code mode session runtime lifecycle", () => {
  it("acquires and releases exactly once across start, replacement, and repeated shutdown", async () => {
    const agentDir = newDirectory("pi-code-mode-lc-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const pi = piStub();
    const probe = makeLifecycleProbe();
    const stateRef = MutableRef.make<CodeModeState | undefined>(undefined);
    const slot = makePiSessionRuntimeSlot<
      CodeModeSessionInput,
      CodeModeApplication,
      never,
      CodeModeRuntimeError
    >({
      makeRuntime: (input) =>
        makePiManagedRuntime(
          pi,
          Layer.merge(
            makeCodeModeLayer(input, {
              publish: (state) => MutableRef.set(stateRef, state),
            }),
            probe.layer,
          ),
        ),
      startup: () => CodeModeConfigStore.use(() => Effect.void),
      onDeactivated: () => MutableRef.set(stateRef, undefined),
    });

    const firstCwd = newDirectory("pi-code-mode-lc-cwd-");
    const first = await slot.start(sessionInput(firstCwd));
    expect(first).toBeDefined();
    expect(probe.acquired()).toBe(1);
    expect(probe.released()).toBe(0);
    expect(MutableRef.get(stateRef)?.projectTrusted).toBe(true);

    // Replacement acquires the new runtime and releases exactly the old one.
    const secondCwd = newDirectory("pi-code-mode-lc-cwd-");
    const second = await slot.start(sessionInput(secondCwd));
    expect(second).toBeDefined();
    expect(slot.isCurrent(second!)).toBe(true);
    expect(probe.acquired()).toBe(2);
    expect(probe.released()).toBe(1);
    expect(MutableRef.get(stateRef)?.projectConfigPath).toContain(secondCwd);

    await slot.shutdown();
    expect(probe.acquired()).toBe(2);
    expect(probe.released()).toBe(2);
    expect(MutableRef.get(stateRef)).toBeUndefined();

    // Repeated shutdown stays idempotent: nothing is double-released.
    await slot.shutdown();
    expect(probe.released()).toBe(2);
    await expect(slot.run(CodeModeConfigStore.use(() => Effect.void))).rejects.toMatchObject({
      _tag: "PiSessionRuntimeError",
    });
  });

  it("releases everything it acquired when startup fails and clears the snapshot", async () => {
    const agentDir = newDirectory("pi-code-mode-lc-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // A file where the extensions directory belongs makes the initial config seed fail.
    writeFileSync(join(agentDir, "extensions"), "not a directory\n");
    const pi = piStub();
    const probe = makeLifecycleProbe();
    const stateRef = MutableRef.make<CodeModeState | undefined>(undefined);
    const failures: number[] = [];
    const slot = makePiSessionRuntimeSlot<
      CodeModeSessionInput,
      CodeModeApplication,
      never,
      CodeModeRuntimeError
    >({
      makeRuntime: (input) =>
        makePiManagedRuntime(
          pi,
          Layer.merge(
            makeCodeModeLayer(input, {
              publish: (state) => MutableRef.set(stateRef, state),
            }),
            probe.layer,
          ),
        ),
      startup: () => CodeModeConfigStore.use(() => Effect.void),
      onDeactivated: () => MutableRef.set(stateRef, undefined),
      onStartFailure: (_input, token) => failures.push(token),
    });

    const cwd = newDirectory("pi-code-mode-lc-cwd-");
    const token = await slot.start(sessionInput(cwd));
    expect(token).toBeUndefined();
    expect(failures).toHaveLength(1);
    expect(probe.acquired()).toBe(probe.released());
    expect(MutableRef.get(stateRef)).toBeUndefined();
    await slot.shutdown();
    expect(probe.acquired()).toBe(probe.released());
  });
});

describe("code mode application lifecycle at the Pi boundary", () => {
  type Handler = ExtensionHandler<any, any>;
  type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

  function applicationHarness() {
    const agentDir = newDirectory("pi-code-mode-lc-agent-");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const handlers = new Map<string, Handler>();
    const commands = new Map<string, CommandDefinition>();
    const notify = vi.fn();
    let activeTools: string[] = [];
    const pi = extensionApiFixture({
      on(name: string, handler: Handler) {
        handlers.set(name, handler);
      },
      registerCommand(name: string, definition: CommandDefinition) {
        commands.set(name, definition);
      },
      registerTool: vi.fn(),
      getActiveTools: () => [...activeTools],
      setActiveTools(names: string[]) {
        activeTools = [...names];
      },
      events: { emit: vi.fn(), on: vi.fn() },
    });
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    registerCodeModeApplication(pi, {
      loadSettings: () => Promise.resolve(undefined),
      wrapTool: (tool) => tool,
      makeNestedDefinitions: () => ({}) as never,
    });

    const makeSignal = () => {
      const added: EventListenerOrEventListenerObject[] = [];
      const removed: EventListenerOrEventListenerObject[] = [];
      const signalFixture = {
        aborted: false,
        addEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
          added.push(listener);
        },
        removeEventListener: (_name: string, listener: EventListenerOrEventListenerObject) => {
          removed.push(listener);
        },
      };
      // SAFETY: Lifecycle tests use only aborted and abort-listener registration.
      const signal = signalFixture as typeof signalFixture & AbortSignal;
      return { signal, added, removed, open: () => added.length - removed.length };
    };
    const makeContext = (cwd: string, signal?: AbortSignal) =>
      extensionContextFixture({
        cwd,
        mode: "rpc",
        hasUI: true,
        signal,
        ui: { notify, custom: vi.fn(), select: vi.fn(), input: vi.fn() },
        isProjectTrusted: vi.fn(() => true),
      });
    return { agentDir, handlers, commands, notify, makeContext, makeSignal };
  }

  it("removes every abort listener it registered on shutdown and replacement", async () => {
    const h = applicationHarness();
    const firstSignal = h.makeSignal();
    const firstCtx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"), firstSignal.signal);
    await h.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);
    // The slot retains exactly one live abort listener for the active session.
    expect(firstSignal.open()).toBe(1);

    const secondSignal = h.makeSignal();
    const secondCtx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"), secondSignal.signal);
    await h.handlers.get("session_start")?.({ reason: "new" }, secondCtx);
    // Replacement releases the previous session's listener exactly once.
    expect(firstSignal.open()).toBe(0);
    expect(secondSignal.open()).toBe(1);

    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, secondCtx);
    expect(secondSignal.open()).toBe(0);

    // Repeated shutdown removes nothing twice.
    await h.handlers.get("session_shutdown")?.({ reason: "quit" }, secondCtx);
    expect(firstSignal.open()).toBe(0);
    expect(secondSignal.open()).toBe(0);
  });

  it("failed replacement clears the previous snapshot instead of leaving it stale", async () => {
    const h = applicationHarness();
    const command = h.commands.get("code-mode-settings");
    const firstCtx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
    await h.handlers.get("session_start")?.({ reason: "startup" }, firstCtx);
    await command?.handler("status", firstCtx);
    expect(h.notify).toHaveBeenCalledWith(
      expect.stringContaining("Code Mode settings — effective values"),
      "info",
    );

    // Break the next session's configuration root so its runtime startup fails.
    const brokenAgentDir = newDirectory("pi-code-mode-lc-agent-");
    process.env.PI_CODING_AGENT_DIR = brokenAgentDir;
    writeFileSync(join(brokenAgentDir, "extensions"), "not a directory\n");
    const secondCtx = h.makeContext(newDirectory("pi-code-mode-lc-cwd-"));
    h.notify.mockClear();
    await h.handlers.get("session_start")?.({ reason: "new" }, secondCtx);
    expect(h.notify).toHaveBeenCalledWith("Code Mode failed to start.", "warning");

    // No stale snapshot from the replaced session leaks through the command surface.
    h.notify.mockClear();
    await command?.handler("status", secondCtx);
    expect(h.notify).toHaveBeenCalledWith("Code Mode settings are unavailable.", "warning");
  });
});
