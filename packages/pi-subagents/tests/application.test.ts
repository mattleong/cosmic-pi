// Promise assertions are test-runner boundaries.
// @effect-diagnostics effect/asyncFunction:off
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";

describe("subagent Pi registration", () => {
  it("defers the agent tool until session settings load", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;

    registerSubagentApplication(pi);

    expect(tools).toEqual([]);
    expect(commands).toEqual(["subagents"]);
    expect(events).toEqual(["session_start", "turn_end", "session_tree", "session_shutdown"]);
  });

  it("fails activation visibly when subagent tool registration throws", async () => {
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
    const notify = vi.fn();
    const pi = {
      registerTool: vi.fn(() => {
        throw new Error("stale extension handle");
      }),
      registerCommand: vi.fn(),
      on: vi.fn((name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
        handlers.set(name, handler);
      }),
      getActiveTools: vi.fn(() => ["read", "subagent_start", "subagent_await"]),
      setActiveTools: vi.fn(),
      sendMessage: vi.fn(),
    } as unknown as ExtensionAPI;
    registerSubagentApplication(pi);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeTypeOf("function");
    await sessionStart?.({}, {
      cwd: process.cwd(),
      signal: undefined,
      hasUI: true,
      mode: "tui",
      isProjectTrusted: () => true,
      ui: { notify },
    } as unknown as ExtensionContext);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read"]);
    expect(notify).toHaveBeenCalledWith(
      "Subagents failed to activate because tool registration failed.",
      "error",
    );
  });
});
