// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/floatingEffect:off
import * as Predicate from "effect/Predicate";
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";
import { initialFastSnapshot } from "../src/fast/controller.ts";
import { abbreviateHomePath, createFooterController } from "../src/footer/controller.ts";
import { textPanel } from "../src/settings/picker.ts";
import { makeProjection } from "../src/usage/index.ts";
import { makeResolvedConfig } from "./helpers.ts";
import { normalizeCosmicUiHostQuery } from "pi-cosmic-ui/protocol";

type EventHandler = ExtensionHandler<any, any>;
type BusHandler = Parameters<ExtensionAPI["events"]["on"]>[1];
type CommandHandler = (args: string, ctx: ExtensionContext) => void | Promise<void>;
type CommandCompletion = (
  prefix: string,
) => Array<{ value: string; label: string; description?: string }> | null;

type Harness = {
  ctx: ExtensionCommandContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, CommandHandler>;
  completions: Map<string, CommandCompletion | undefined>;
  custom: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  getEntries: ReturnType<typeof vi.fn>;
  getLeafId: ReturnType<typeof vi.fn>;
  getCwd: ReturnType<typeof vi.fn>;
  getContextUsage: ReturnType<typeof vi.fn>;
  getSessionName: ReturnType<typeof vi.fn>;
  getThinkingLevel: ReturnType<typeof vi.fn>;
  setFooter: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  cosmicEvents: Array<{ channel: string; data: unknown }>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-footer-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(
  cwd: string,
  footerMode: "replace" | "status" | "off",
  options: { fastEnabled?: boolean } = {},
) {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: options.fastEnabled ?? false,
        active: options.fastEnabled ?? false,
        desiredActive: options.fastEnabled ?? false,
        usage: { enabled: false },
        footer: { mode: footerMode },
        image: { enabled: false },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createHarness(cwd: string, options: { cosmicHost?: boolean } = {}): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const eventHandlers = new Map<string, Set<BusHandler>>();
  const cosmicEvents: Array<{ channel: string; data: unknown }> = [];
  const commands = new Map<string, CommandHandler>();
  const completions = new Map<string, CommandCompletion | undefined>();
  const custom = vi.fn();
  const notify = vi.fn();
  const getEntries = vi.fn((): unknown[] => []);
  const getLeafId = vi.fn(() => "leaf-1");
  const getCwd = vi.fn(() => cwd);
  const getContextUsage = vi.fn(() => ({ contextWindow: 100_000, percent: 12.5 }));
  const getSessionName = vi.fn(() => undefined);
  const getThinkingLevel = vi.fn(() => "off");
  const setFooter = vi.fn();
  const setStatus = vi.fn();

  if (options.cosmicHost) {
    eventHandlers.set(
      "cosmic-ui:v1:host:query",
      new Set([
        (data) => {
          normalizeCosmicUiHostQuery(data)?.respond();
        },
      ]),
    );
  }

  const piFixture = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerCommand(
      name: string,
      command: { handler: CommandHandler; getArgumentCompletions?: CommandCompletion },
    ) {
      commands.set(name, command.handler);
      completions.set(name, command.getArgumentCompletions);
    },
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel,
    events: {
      emit<DataInput>(channel: string, data: DataInput) {
        cosmicEvents.push({ channel, data });
        for (const handler of eventHandlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: BusHandler) {
        const channelHandlers = eventHandlers.get(channel) ?? new Set();
        channelHandlers.add(handler);
        eventHandlers.set(channel, channelHandlers);
        return () => channelHandlers.delete(handler);
      },
    },
  };
  // SAFETY: Better OpenAI registration uses only the ExtensionAPI methods implemented here.
  const pi = piFixture as typeof piFixture & ExtensionAPI;

  const contextFixture = {
    cwd,
    isProjectTrusted: () => true,
    mode: "tui",
    hasUI: true,
    signal: undefined,
    model: undefined,
    ui: {
      custom,
      notify,
      setFooter,
      setStatus,
    },
    sessionManager: {
      getEntries,
      getLeafId,
      getCwd,
      getSessionName,
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage,
  };
  // SAFETY: This harness supplies every context member exercised by events and commands.
  const ctx = contextFixture as typeof contextFixture & ExtensionCommandContext;

  betterOpenAI(pi);

  return {
    ctx,
    handlers,
    commands,
    completions,
    custom,
    notify,
    getEntries,
    getLeafId,
    getCwd,
    getContextUsage,
    getSessionName,
    getThinkingLevel,
    setFooter,
    setStatus,
    cosmicEvents,
  };
}

async function emit<PayloadInput>(harness: Harness, event: string, payload?: PayloadInput) {
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    await handler(payload ?? {}, harness.ctx);
  }
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("footer path formatting", () => {
  test("abbreviates only exact home and child paths", () => {
    expect(abbreviateHomePath("/Users/alice/project")).toBe("~/project");
    expect(abbreviateHomePath("/Users/alice")).toBe("~");
    expect(abbreviateHomePath("/home/alice/project")).toBe("~/project");
    expect(abbreviateHomePath("/project")).toBe("/project");
  });
});

describe("diagnostic text panel", () => {
  test("closes only for explicit close keys, not arrow escape sequences", () => {
    const done = vi.fn();
    const panel = textPanel("Diagnostics", ["line"], done);

    panel.handleInput("\x1b[A");
    expect(done).not.toHaveBeenCalled();

    panel.handleInput("\x1b");
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("footer mode ownership", () => {
  test("reuses context usage between renders and invalidates it on message changes", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );

    footer.render(100);
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(1);
    expect(harness.getSessionName).toHaveBeenCalledTimes(1);

    await emit(harness, "message_update");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(2);

    harness.getLeafId.mockReturnValue("leaf-2");
    footer.render(100);
    expect(harness.getContextUsage).toHaveBeenCalledTimes(3);
    expect(harness.getSessionName).toHaveBeenCalledTimes(2);
    footer.dispose();
  });

  test("prefixes the effort level with lightning when fast mode is active", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace", { fastEnabled: true });
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, {
      model: {
        provider: "openai",
        id: "gpt-5.5",
        reasoning: true,
        contextWindow: 200_000,
      },
    });

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );

    expect(footer.render(100).join("\n")).toContain("gpt-5.5 • ⚡thinking off");
    footer.dispose();
  });

  test("keeps synchronous footer rendering total when OAuth lookup throws", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, {
      model: { provider: "openai", id: "gpt-5.5", contextWindow: 200_000 },
    });
    harness.ctx.modelRegistry.isUsingOAuth = () => {
      throw new Error("host registry failed");
    };

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );

    expect(() => footer.render(100)).not.toThrow();
    expect(footer.render(100).join("\n")).not.toContain("(sub)");
    footer.dispose();
  });

  test("retries a failed footer installation without activating its stale factory", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    const staleRequest = vi.fn();
    const activeRequest = vi.fn();
    let staleFooter: { dispose(): void; render(width: number): string[] } | undefined;
    let activeFooter: { dispose(): void } | undefined;

    harness.setFooter
      .mockImplementationOnce((factory) => {
        staleFooter = factory(
          { requestRender: staleRequest },
          { fg: (_color: string, value: string) => value },
          { onBranchChange: vi.fn() },
        );
        throw new Error("host rejected footer");
      })
      .mockImplementationOnce((factory) => {
        activeFooter = factory(
          { requestRender: activeRequest },
          { fg: (_color: string, value: string) => value },
          { onBranchChange: vi.fn() },
        );
      });

    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(staleRequest).not.toHaveBeenCalled();
    expect(staleFooter?.render(100)).toEqual([]);

    await emit(harness, "agent_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    staleFooter?.dispose();

    await emit(harness, "agent_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(staleRequest).not.toHaveBeenCalled();
    expect(activeRequest).toHaveBeenCalledTimes(1);
    activeFooter?.dispose();
  });

  test("returns an empty footer when host-owned render getters throw", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    const model = {
      provider: "openai",
      id: "gpt-5.5",
      reasoning: true,
      contextWindow: 200_000,
    };
    Object.assign(harness.ctx, { model });
    const getAvailableProviderCount = vi.fn(() => 2);
    const getGitBranch = vi.fn(() => "main");
    const getExtensionStatuses = vi.fn(() => new Map([["test", "ready"]]));
    const fg = vi.fn((_color: string, value: string) => value);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg },
      { getAvailableProviderCount, getGitBranch, getExtensionStatuses },
    );
    const safe = footer.render(100);
    expect(safe).not.toEqual([]);
    expect(safe.join("\n")).toContain(cwd);

    harness.getLeafId.mockImplementationOnce(() => {
      throw new Error("leaf unavailable");
    });
    expect(footer.render(100)).toEqual([]);

    Object.assign(harness.ctx, {
      model: { ...model, id: "gpt-session-b" },
    });
    harness.getCwd.mockImplementationOnce(() => {
      throw new Error("cwd unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    Object.assign(harness.ctx, { model });

    harness.getLeafId.mockReturnValue("leaf-2");
    harness.getSessionName.mockImplementationOnce(() => {
      throw new Error("session name unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    expect(footer.render(100)).toEqual(safe);
    expect(harness.getSessionName).toHaveBeenCalledTimes(3);

    await emit(harness, "message_update");
    harness.getContextUsage.mockImplementationOnce(() => {
      throw new Error("context unavailable");
    });
    expect(footer.render(100)).toEqual([]);

    await emit(harness, "message_update");
    harness.getContextUsage.mockReturnValueOnce({
      contextWindow: 100_000,
      get percent() {
        throw new Error("percent unavailable");
      },
    });
    expect(footer.render(100)).toEqual([]);
    expect(footer.render(100)).toEqual(safe);

    harness.getThinkingLevel.mockImplementationOnce(() => {
      throw new Error("thinking unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    getAvailableProviderCount.mockImplementationOnce(() => {
      throw new Error("providers unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    getGitBranch.mockImplementationOnce(() => {
      throw new Error("branch unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    getExtensionStatuses.mockImplementationOnce(() => {
      throw new Error("statuses unavailable");
    });
    expect(footer.render(100)).toEqual([]);
    fg.mockImplementationOnce(() => {
      throw new Error("theme unavailable");
    });
    expect(footer.render(100)).toEqual([]);

    const firstFailure = footerFactory(
      { requestRender: vi.fn() },
      {
        fg: () => {
          throw new Error("theme unavailable");
        },
      },
      {},
    );
    expect(firstFailure.render(100)).toEqual([]);
    expect(firstFailure.render(0)).toEqual([]);
    expect(firstFailure.render(Number.NaN)).toEqual([]);
    expect(firstFailure.render(Number.POSITIVE_INFINITY)).toEqual([]);
    expect(() => firstFailure.dispose()).not.toThrow();
    expect(() => footer.dispose()).not.toThrow();
  });

  test("isolates branch subscription, render request, and disposal callbacks", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    const requestRender = vi.fn(() => {
      throw new Error("render request failed");
    });
    const unsubscribe = vi.fn(() => {
      throw new Error("unsubscribe failed");
    });
    let branchChanged: (() => void) | undefined;

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender },
      { fg: (_color: string, value: string) => value },
      {
        onBranchChange(callback: () => void) {
          branchChanged = callback;
          return unsubscribe;
        },
      },
    );

    expect(() => branchChanged?.()).not.toThrow();
    await expect(emit(harness, "agent_start")).resolves.toBeUndefined();
    expect(() => footer.dispose()).not.toThrow();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("adds completed-turn usage without rescanning the full session", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await emit(harness, "turn_end", {
      message: {
        role: "assistant",
        usage: {
          input: 1_200,
          output: 300,
          cacheRead: 400,
          cacheWrite: 50,
          cost: { total: 0.25 },
        },
      },
      toolResults: [],
    });

    expect(harness.getEntries).toHaveBeenCalledTimes(1);
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );
    expect(footer.render(100).join("\n")).toContain("↑1.2k ↓300 R400 W50 $0.250");
    footer.dispose();
  });

  test("does not retain prior-session totals when a new session scan throws", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    harness.getEntries.mockReturnValue([
      {
        type: "message",
        message: {
          role: "assistant",
          usage: {
            input: 1_200,
            output: 300,
            cacheRead: 400,
            cacheWrite: 50,
            cost: { total: 0.25 },
          },
        },
      },
    ]);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );
    expect(footer.render(100).join("\n")).toContain("↑1.2k");

    harness.getEntries.mockImplementation(() => {
      throw new Error("new session entries unavailable");
    });
    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(footer.render(100).join("\n")).not.toContain("↑1.2k");
    footer.dispose();
  });

  test("publishes primitives instead of installing its footer when Cosmic UI is present", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace", { fastEnabled: true });
    const harness = createHarness(cwd, { cosmicHost: true });
    Object.assign(harness.ctx, {
      model: {
        provider: "openai",
        id: "gpt-5.5",
        reasoning: true,
        contextWindow: 200_000,
      },
    });

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.cosmicEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ channel: "cosmic-ui:v1:host:query" }),
        expect.objectContaining({
          channel: "cosmic-ui:v1:footer:upsert",
          data: expect.objectContaining({
            owner: "pi-better-openai",
            contribution: expect.objectContaining({ kind: "text", id: "openai.fast" }),
          }),
        }),
      ]),
    );
  });

  test("does not install terminal-only UI in RPC mode", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("renders and navigates hierarchical TUI settings with redacted diagnostics", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status");
    const configPath = join(cwd, ".pi", "extensions", "pi-better-openai.json");
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    writeFileSync(configPath, JSON.stringify({ ...raw, accessToken: "sk-secret-value" }));
    const harness = createHarness(cwd);
    initTheme(undefined, false);
    let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
    harness.custom.mockImplementation((factory) => {
      component = factory(
        { requestRender: vi.fn() },
        {
          fg: (_tone: string, text: string) => text,
          bold: (text: string) => text,
        },
        {},
        vi.fn(),
      );
      return Promise.resolve(undefined);
    });

    await emit(harness, "session_start");
    await harness.commands.get("openai-settings")?.("", harness.ctx);
    const root = component!.render(120).join("\n");
    expect(root).toContain("Fast mode");
    expect(root).toContain("Compaction");
    expect(root).toContain("Footer");
    expect(root).toContain("Usage");
    expect(root).toContain("Image tool");
    expect(root).toContain("Diagnostics");

    for (let index = 0; index < 5; index++) component!.handleInput("\x1b[B");
    component!.handleInput("\r");
    expect(component!.render(120).join("\n")).toContain("Diagnostics");
    component!.handleInput("\x1b[B");
    component!.handleInput("\x1b[B");
    component!.handleInput("\r");
    const redacted = component!.render(120).join("\n");
    expect(redacted).toContain("Redacted config");
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).not.toContain("sk-secret-value");
  });

  test("does not open the custom settings component in RPC mode", async () => {
    const cwd = createTempProject();
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, { mode: "rpc", hasUI: true });

    await harness.commands.get("openai-settings")?.("", harness.ctx);

    expect(harness.custom).not.toHaveBeenCalled();
    expect(harness.notify).toHaveBeenCalledWith(
      "Better OpenAI settings require interactive TUI mode.",
      "warning",
    );
  });

  test("completes /openai-settings ids, help/diagnostics, and finite values", () => {
    const cwd = createTempProject();
    const harness = createHarness(cwd);
    const complete = harness.completions.get("openai-settings");
    expect(complete).toBeTypeOf("function");
    const values = (prefix: string) => complete?.(prefix)?.map((entry) => entry.value) ?? null;

    expect(values("")).toEqual(
      expect.arrayContaining([
        "fast.enabled",
        "footer.mode",
        "usage.enabled",
        "help",
        "diagnostics",
      ]),
    );
    expect(values("fast.e")).toEqual(["fast.enabled"]);
    expect(values("fast.enabled ")).toEqual(["fast.enabled true", "fast.enabled false"]);
    expect(values("fast.enabled f")).toEqual(["fast.enabled false"]);
    expect(values("usage.s")).toEqual([
      "usage.showOnlyOnSubscriptionModels",
      "usage.showResetTimes",
    ]);
    expect(values("HELP")).toEqual(["help"]);
    expect(complete?.("zzz")).toBeNull();
    expect(complete?.("unknown ")).toBeNull();
  });

  test("off mode leaves existing footer customizations untouched on session start", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "off");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
    expect(harness.setStatus).not.toHaveBeenCalled();
  });

  test("status mode does not clear an external custom footer", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");

    expect(harness.setFooter).not.toHaveBeenCalled();
  });

  test("off mode clears the Better OpenAI footer only after Better OpenAI installed it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(harness.setFooter).toHaveBeenLastCalledWith(expect.any(Function));

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);
  });

  test("retries footer removal only after the host accepts it", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    harness.setFooter.mockImplementationOnce(() => {
      throw new Error("footer removal failed");
    });
    writeProjectConfig(cwd, "off");

    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);

    await emit(harness, "agent_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(3);
    expect(harness.setFooter).toHaveBeenLastCalledWith(undefined);
    await emit(harness, "agent_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(3);
  });

  test("does not retry removal after the host disposed the owned footer before throwing", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    const footer = footerFactory(
      { requestRender: vi.fn() },
      { fg: (_color: string, value: string) => value },
      {},
    );
    harness.setFooter.mockImplementationOnce(() => {
      footer.dispose();
      throw new Error("host failed after disposal");
    });
    writeProjectConfig(cwd, "off");

    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(harness.setFooter).toHaveBeenCalledTimes(2);
    await emit(harness, "agent_start");
    expect(harness.setFooter).toHaveBeenCalledTimes(2);
  });

  test("preserves a reentrant replacement installed while the prior footer clears", () => {
    let mode: "replace" | "off" = "replace";
    let reenter = false;
    let component: { dispose(): void } | undefined;
    const requestRender = vi.fn();
    let controller: ReturnType<typeof createFooterController>;
    const setFooter = vi.fn((factory) => {
      if (Predicate.isFunction(factory)) {
        component = factory(
          { requestRender },
          { fg: (_color: string, value: string) => value },
          {},
        );
        return;
      }
      if (!reenter) return;
      reenter = false;
      component?.dispose();
      mode = "replace";
      controller.update(ctx);
    });
    const contextFixture = {
      mode: "tui",
      hasUI: true,
      model: undefined,
      ui: { setFooter, setStatus: vi.fn() },
      sessionManager: {
        getEntries: () => [],
        getLeafId: () => null,
        getCwd: () => "/project",
        getSessionName: () => undefined,
      },
      modelRegistry: { isUsingOAuth: () => false },
      getContextUsage: () => ({ contextWindow: 100_000, percent: 0 }),
    };
    // SAFETY: Footer projection reads only the context fields implemented by this fixture.
    const ctx = contextFixture as typeof contextFixture & ExtensionContext;
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    controller = createFooterController({
      pi: { getThinkingLevel: () => "off" } as ExtensionAPI,
      config: () => makeResolvedConfig({ footer: { mode } }),
      fastProjection: MutableRef.make(initialFastSnapshot()),
      projection: makeProjection(),
      hasTerminalUI: () => true,
    });

    controller.update(ctx);
    mode = "off";
    reenter = true;
    controller.update(ctx);

    expect(setFooter).toHaveBeenCalledTimes(3);
    controller.update(ctx);
    expect(setFooter).toHaveBeenCalledTimes(3);
    expect(requestRender).toHaveBeenCalledTimes(1);
  });

  test("retries status mutations without blocking footer installation", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "status", { fastEnabled: true });
    const harness = createHarness(cwd);
    Object.assign(harness.ctx, {
      model: { provider: "openai", id: "gpt-5.5", contextWindow: 200_000 },
    });
    harness.setStatus.mockImplementationOnce(() => {
      throw new Error("status set failed");
    });

    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(harness.setStatus).toHaveBeenCalledTimes(1);
    await emit(harness, "agent_start");
    expect(harness.setStatus).toHaveBeenCalledTimes(2);

    harness.setStatus.mockImplementationOnce(() => {
      throw new Error("status clear failed");
    });
    writeProjectConfig(cwd, "replace");
    await expect(emit(harness, "session_start")).resolves.toBeUndefined();
    expect(harness.setFooter).toHaveBeenCalledTimes(1);
    expect(harness.setStatus).toHaveBeenCalledTimes(3);

    await emit(harness, "agent_start");
    expect(harness.setStatus).toHaveBeenCalledTimes(4);
    expect(harness.setStatus).toHaveBeenLastCalledWith("better-openai", undefined);
  });

  test("off mode does not clear a footer after Better OpenAI's footer was disposed", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, "replace");
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const footerFactory = harness.setFooter.mock.calls[0]?.[0];
    expect(footerFactory).toEqual(expect.any(Function));

    const footer = footerFactory(
      { requestRender: vi.fn() },
      {},
      { onBranchChange: vi.fn(() => vi.fn()) },
    );
    footer.dispose();

    writeProjectConfig(cwd, "off");
    await emit(harness, "session_start");

    expect(harness.setFooter).toHaveBeenCalledTimes(1);
  });
});
