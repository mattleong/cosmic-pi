import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerSubagentApplication } from "../src/application/register.ts";

describe("subagent Pi registration", () => {
  it("registers one tool, one command, and session lifecycle events", () => {
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

    expect(tools).toEqual(["subagent"]);
    expect(commands).toEqual(["subagents"]);
    expect(events).toEqual(["session_start", "turn_end", "session_shutdown"]);
  });
});
