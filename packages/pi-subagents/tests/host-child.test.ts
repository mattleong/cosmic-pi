// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import subagentChildBridge from "../src/boundary/host-child.ts";

describe("subagent child host bridge", () => {
  it("injects the priority service tier only for fast-capable OpenAI models", () => {
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      const handlers = new Map<string, (...args: unknown[]) => unknown>();
      const pi = {
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => true),
        registerTool: vi.fn(),
        on: vi.fn((name: string, handler: (...args: unknown[]) => unknown) =>
          handlers.set(name, handler),
        ),
      } as unknown as ExtensionAPI;
      subagentChildBridge(pi);
      const beforeRequest = handlers.get("before_provider_request");
      expect(
        beforeRequest?.(
          { payload: { input: "task" } },
          { model: { provider: "openai-codex", id: "gpt-5.6-sol" } },
        ),
      ).toEqual({ input: "task", service_tier: "priority" });
      expect(
        beforeRequest?.(
          { payload: { input: "task" } },
          { model: { provider: "anthropic", id: "claude-opus-4-6" } },
        ),
      ).toBeUndefined();
    } finally {
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
    }
  });

  it("installs runtime-only parent authentication without process arguments", () => {
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const previousKey = process.env.PI_SUBAGENT_RUNTIME_API_KEY;
    const previousProvider = process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;
    process.env.PI_SUBAGENT_CHILD = "1";
    process.env.PI_SUBAGENT_RUNTIME_API_KEY = "runtime-secret";
    process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER = "custom-provider";
    try {
      const registerProvider = vi.fn();
      const pi = {
        registerProvider,
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => false),
        registerTool: vi.fn(),
        on: vi.fn(),
      } as unknown as ExtensionAPI;

      subagentChildBridge(pi);

      expect(registerProvider).toHaveBeenCalledWith("custom-provider", {
        apiKey: "runtime-secret",
      });
      expect(process.env.PI_SUBAGENT_RUNTIME_API_KEY).toBeUndefined();
      expect(process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER).toBeUndefined();
    } finally {
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
      if (previousKey === undefined) delete process.env.PI_SUBAGENT_RUNTIME_API_KEY;
      else process.env.PI_SUBAGENT_RUNTIME_API_KEY = previousKey;
      if (previousProvider === undefined) delete process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER;
      else process.env.PI_SUBAGENT_RUNTIME_API_PROVIDER = previousProvider;
    }
  });

  it("keeps the prefixed contact_parent reply within the universal tool cap", async () => {
    const previousChild = process.env.PI_SUBAGENT_CHILD;
    const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
    const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      let registered:
        | {
            readonly execute: (
              id: string,
              params: { readonly kind: "question"; readonly message: string },
              signal?: AbortSignal,
            ) => Promise<{ readonly content: ReadonlyArray<{ readonly text: string }> }>;
          }
        | undefined;
      const handlers = new Map<string, () => void>();
      let outbound: { readonly requestId?: string } | undefined;
      Object.defineProperty(process, "connected", { configurable: true, value: true });
      Object.defineProperty(process, "send", {
        configurable: true,
        value: (message: object, callback: (error?: Error | null) => void) => {
          outbound = message;
          callback(null);
        },
      });
      const pi = {
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => false),
        registerTool: vi.fn((tool: typeof registered) => {
          registered = tool;
        }),
        on: vi.fn((name: string, handler: () => void) => handlers.set(name, handler)),
      } as unknown as ExtensionAPI;
      subagentChildBridge(pi);
      handlers.get("session_start")?.();

      const executing = registered?.execute("call", { kind: "question", message: "Question?" });
      await Promise.resolve();
      (process.emit as (...args: unknown[]) => boolean)("message", {
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: outbound?.requestId,
        message: "x".repeat(65_536),
      });
      const result = await executing;
      const text = result?.content[0]?.text ?? "";
      expect(text.startsWith("Parent replied: ")).toBe(true);
      expect(text.length).toBeLessThanOrEqual(48_000);
      handlers.get("session_shutdown")?.();
    } finally {
      if (sendDescriptor) Object.defineProperty(process, "send", sendDescriptor);
      else delete (process as { send?: unknown }).send;
      if (connectedDescriptor) Object.defineProperty(process, "connected", connectedDescriptor);
      else delete (process as { connected?: unknown }).connected;
      if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previousChild;
    }
  });

  it("serializes contact_parent calls with a strict bounded schema", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      let registered: Pick<ToolDefinition, "name" | "executionMode" | "parameters"> | undefined;
      const pi = {
        registerFlag: vi.fn(),
        getFlag: vi.fn(() => false),
        registerTool: vi.fn(
          (tool: Pick<ToolDefinition, "name" | "executionMode" | "parameters">) => {
            registered = tool;
          },
        ),
        on: vi.fn(),
      } as unknown as ExtensionAPI;

      subagentChildBridge(pi);

      expect(registered).toMatchObject({
        name: "contact_parent",
        executionMode: "sequential",
        parameters: {
          additionalProperties: false,
          properties: { message: { minLength: 1, maxLength: 65_536, pattern: ".*\\S.*" } },
        },
      });
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });
});
