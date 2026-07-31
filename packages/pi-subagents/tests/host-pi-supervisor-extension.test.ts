// Promise-shaped Pi host boundary test.
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/processEnv:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const bridgeCalls: Array<{
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}> = [];
const close = vi.fn();
vi.mock("../src/boundary/pi-supervisor-bridge-client.ts", () => ({
  openPiSupervisorBridge: vi.fn(async () => ({
    call: async (name: string, input: Readonly<Record<string, unknown>>) => {
      bridgeCalls.push({ name, input });
      return "accepted";
    },
    close,
  })),
}));

import registerBridge from "../src/boundary/host-pi-supervisor-extension.ts";

afterEach(() => {
  bridgeCalls.length = 0;
  close.mockClear();
  vi.unstubAllEnvs();
});

describe("Herdr-hosted Pi bridge extension", () => {
  it("deletes ephemeral provider credentials before a config-validation return", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => undefined),
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
      registerProvider: vi.fn(),
    } as unknown as ExtensionAPI;
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "must-be-deleted");
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");
    registerBridge(pi);
    await handlers.get("session_start")?.({}, { hasUI: false });
    expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();
    expect(process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER).toBeUndefined();
    expect(pi.registerProvider).not.toHaveBeenCalled();
  });

  it("registers only four cooperative supervisor tools with strict inputs", async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const tools: Array<{
      readonly name: string;
      readonly execute: (
        id: string,
        input: Readonly<Record<string, unknown>>,
        signal?: AbortSignal,
      ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
      readonly renderCall?: unknown;
    }> = [];
    let active = ["read", "subagent_start", "herdr_agent_start", "contact_parent"];
    const registeredProviders: Array<readonly [string, unknown]> = [];
    const pi = {
      registerFlag: vi.fn(),
      getFlag: vi.fn(() => "/private/supervisor/connection.json"),
      on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
      ),
      registerTool: vi.fn((tool: (typeof tools)[number]) => tools.push(tool)),
      getActiveTools: vi.fn(() => active),
      setActiveTools: vi.fn((next: string[]) => void (active = next)),
      registerProvider: vi.fn(
        (name: string, options: unknown) => void registeredProviders.push([name, options]),
      ),
    } as unknown as ExtensionAPI;
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_KEY", "private-runtime-key");
    vi.stubEnv("PI_SUBAGENT_RUNTIME_API_PROVIDER", "openai-codex");

    registerBridge(pi);
    const start = handlers.get("session_start");
    expect(start).toBeDefined();
    await start?.(
      {},
      {
        cwd: "/project",
        isProjectTrusted: () => false,
        hasUI: false,
      },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "supervisor_progress",
      "supervisor_warning",
      "supervisor_question",
      "supervisor_submit_report",
    ]);
    expect(tools.every((tool) => typeof tool.renderCall === "function")).toBe(true);
    expect(active).toContain("read");
    expect(active).not.toContain("subagent_start");
    expect(active).not.toContain("herdr_agent_start");
    expect(active).not.toContain("contact_parent");
    expect(registeredProviders).toEqual([["openai-codex", { apiKey: "private-runtime-key" }]]);
    expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();

    const result = await tools[0]?.execute("call-1", { message: "progress" });
    expect(result?.content[0]?.text).toBe("accepted");
    expect(bridgeCalls).toEqual([{ name: "supervisor_progress", input: { message: "progress" } }]);
    await expect(tools[0]?.execute("call-2", { message: "progress", extra: true })).rejects.toThrow(
      "malformed",
    );

    handlers.get("session_shutdown")?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
