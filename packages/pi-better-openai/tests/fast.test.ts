// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalDate:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/floatingEffect:off
import type { ExtensionHandler } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, test, vi } from "vitest";
import betterOpenAI from "../index.ts";
import { resetOpenAICodexTransport } from "../src/boundary/host-provider-routing.ts";
import type { ConfigFile } from "../src/config/schema.ts";

type EventHandler = ExtensionHandler<any, any>;
type CommandHandler = NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>;

type Harness = {
  ctx: ExtensionCommandContext;
  handlers: Map<string, EventHandler[]>;
  commands: Map<string, { handler: CommandHandler }>;
};

const tempDirs: string[] = [];

function createTempProject() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-better-openai-fast-"));
  tempDirs.push(cwd);
  return cwd;
}

function writeProjectConfig(cwd: string, overrides: ConfigFile = {}): void {
  const configDir = join(cwd, ".pi", "extensions");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "pi-better-openai.json"),
    `${JSON.stringify(
      {
        persistState: true,
        active: false,
        desiredActive: false,
        usage: { enabled: false },
        footer: { mode: "off" },
        image: { enabled: false },
        ...overrides,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function createModel(
  provider: string,
  id: string,
  overrides: Partial<NonNullable<ExtensionContext["model"]>> = {},
) {
  // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
  return {
    provider,
    id,
    api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
    baseUrl:
      provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
    ...overrides,
  } as ExtensionContext["model"];
}

function createHarness(cwd: string, model = createModel("openai", "gpt-5.5")): Harness {
  const handlers = new Map<string, EventHandler[]>();
  const commands = new Map<string, { handler: CommandHandler }>();

  const piFixture = {
    on(event: string, handler: EventHandler) {
      const currentHandlers = handlers.get(event) ?? [];
      currentHandlers.push(handler);
      handlers.set(event, currentHandlers);
    },
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: { handler: CommandHandler }) => {
      commands.set(name, command);
    }),
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    getFlag: vi.fn(() => false),
    getThinkingLevel: vi.fn(() => "off"),
  };
  // SAFETY: Better OpenAI registration uses only the ExtensionAPI methods implemented here.
  const pi = piFixture as typeof piFixture & ExtensionAPI;

  const contextFixture = {
    cwd,
    isProjectTrusted: () => true,
    hasUI: false,
    signal: undefined,
    model,
    ui: {
      notify: vi.fn(),
      setFooter: vi.fn(),
      setStatus: vi.fn(),
    },
    sessionManager: {
      getEntries: vi.fn(() => []),
      getCwd: vi.fn(() => cwd),
      getSessionId: vi.fn(() => "session-fast"),
      getSessionName: vi.fn(() => undefined),
    },
    modelRegistry: {
      isUsingOAuth: vi.fn(() => false),
    },
    getContextUsage: vi.fn(() => ({ contextWindow: 0, percent: 0 })),
  };
  // SAFETY: This harness supplies every context member exercised by events and commands.
  const ctx = contextFixture as typeof contextFixture & ExtensionCommandContext;

  betterOpenAI(pi);

  return { ctx, handlers, commands };
}

async function emit<PayloadInput>(
  harness: Harness,
  event: string,
  payload?: PayloadInput,
): Promise<unknown[]> {
  const results: unknown[] = [];
  const handlers = harness.handlers.get(event) ?? [];
  for (const handler of handlers) {
    results.push(await handler(payload ?? {}, harness.ctx));
  }
  return results;
}

async function beforeProviderRequest(harness: Harness, payload: Schema.JsonObject) {
  const results = await emit(harness, "before_provider_request", { payload });
  return results.find((result) => result !== undefined);
}

async function beforeProviderHeaders(
  harness: Harness,
  headers: Record<string, string | null>,
): Promise<Record<string, string | null>> {
  await emit(harness, "before_provider_headers", { headers });
  return headers;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("fast mode provider injection", () => {
  test("closes the cached provider transport for the current Pi session", () => {
    const cwd = createTempProject();
    const harness = createHarness(cwd);
    const closeSessions = vi.fn();

    resetOpenAICodexTransport(harness.ctx, closeSessions);

    expect(closeSessions).toHaveBeenCalledWith("session-fast");
  });

  test("injects priority service tier when persisted fast mode is active for a supported model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: true, desiredActive: true });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const payload = { model: "gpt-5.5", messages: [] };
    const result = await beforeProviderRequest(harness, payload);

    expect(result).toEqual({ model: "gpt-5.5", messages: [], service_tier: "priority" });
    expect(payload).toEqual({ model: "gpt-5.5", messages: [] });
  });

  test("does not inject for unsupported models and leaves the payload unchanged", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: true, desiredActive: true });
    const harness = createHarness(cwd, createModel("openai", "gpt-4.1"));

    await emit(harness, "session_start");
    const payload = { model: "gpt-4.1" };

    await expect(beforeProviderRequest(harness, payload)).resolves.toBeUndefined();
    expect(payload).toEqual({ model: "gpt-4.1" });
  });

  test("does not inject when fast mode is disabled and leaves the payload unchanged", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: false, desiredActive: false });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    const payload = { model: "gpt-5.5" };

    await expect(beforeProviderRequest(harness, payload)).resolves.toBeUndefined();
    expect(payload).toEqual({ model: "gpt-5.5" });
  });

  test("adds the fast routing hint only for the canonical Codex transport", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: true, desiredActive: true });
    const harness = createHarness(cwd, createModel("openai-codex", "gpt-5.6-luna"));

    await emit(harness, "session_start");
    const headers = { "x-existing": "keep" };

    await expect(beforeProviderHeaders(harness, headers)).resolves.toEqual({
      "x-existing": "keep",
      "x-codex-routing-hint": "model=gpt-5.6-luna;tier=priority",
    });
  });

  test("preserves an existing canonical Codex routing hint while fast mode is disabled", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: false, desiredActive: false });
    const harness = createHarness(cwd, createModel("openai-codex", "gpt-5.6-luna"));

    await emit(harness, "session_start");

    await expect(
      beforeProviderHeaders(harness, {
        "x-codex-routing-hint": "provider-owned",
        "x-existing": "keep",
      }),
    ).resolves.toEqual({
      "x-codex-routing-hint": "provider-owned",
      "x-existing": "keep",
    });
  });

  test("does not change routing headers for direct OpenAI or noncanonical Codex endpoints", async () => {
    const directCwd = createTempProject();
    writeProjectConfig(directCwd, { active: true, desiredActive: true });
    const direct = createHarness(directCwd);
    await emit(direct, "session_start");
    await expect(
      beforeProviderHeaders(direct, { "x-codex-routing-hint": "provider-owned" }),
    ).resolves.toEqual({ "x-codex-routing-hint": "provider-owned" });

    const proxyCwd = createTempProject();
    writeProjectConfig(proxyCwd, { active: true, desiredActive: true });
    const proxy = createHarness(
      proxyCwd,
      createModel("openai-codex", "gpt-5.6-luna", {
        baseUrl: "https://proxy.example.com/backend-api",
      }),
    );
    await emit(proxy, "session_start");
    await expect(beforeProviderHeaders(proxy, { "x-existing": "keep" })).resolves.toEqual({
      "x-existing": "keep",
    });
  });

  test("/fast toggles injection on for the current supported model", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: false, desiredActive: false });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await harness.commands.get("fast")?.handler("", harness.ctx);

    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });
  });

  test("session shutdown clears the frozen fast snapshot before later provider callbacks", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: true, desiredActive: true });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });
    await emit(harness, "session_shutdown");
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toBeUndefined();
  });

  test("model selection deactivates injection for unsupported models and reactivates for supported models", async () => {
    const cwd = createTempProject();
    writeProjectConfig(cwd, { active: true, desiredActive: true });
    const harness = createHarness(cwd);

    await emit(harness, "session_start");
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });

    harness.ctx.model = createModel("openai", "gpt-4.1");
    await emit(harness, "model_select", { model: harness.ctx.model });
    const unsupportedPayload = { model: "gpt-4.1" };
    await expect(beforeProviderRequest(harness, unsupportedPayload)).resolves.toBeUndefined();
    expect(unsupportedPayload).toEqual({ model: "gpt-4.1" });

    harness.ctx.model = createModel("openai", "gpt-5.5");
    await emit(harness, "model_select", { model: harness.ctx.model });
    await expect(beforeProviderRequest(harness, { model: "gpt-5.5" })).resolves.toMatchObject({
      service_tier: "priority",
    });
  });
});
