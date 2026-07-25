// @effect-diagnostics effect/processEnv:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import subagentChildBridge from "../src/boundary/host-child.ts";

describe("subagent child host bridge", () => {
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

  it("serializes contact_parent calls so blocking questions cannot overlap", () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    process.env.PI_SUBAGENT_CHILD = "1";
    try {
      let registered: { readonly name: string; readonly executionMode?: string } | undefined;
      const pi = {
        registerTool: vi.fn((tool: { readonly name: string; readonly executionMode?: string }) => {
          registered = tool;
        }),
        on: vi.fn(),
      } as unknown as ExtensionAPI;

      subagentChildBridge(pi);

      expect(registered).toMatchObject({
        name: "contact_parent",
        executionMode: "sequential",
      });
    } finally {
      if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
      else process.env.PI_SUBAGENT_CHILD = previous;
    }
  });
});
