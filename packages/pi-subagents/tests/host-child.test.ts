// @effect-diagnostics effect/processEnv:off
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import subagentChildBridge from "../src/boundary/host-child.ts";

describe("subagent child host bridge", () => {
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
