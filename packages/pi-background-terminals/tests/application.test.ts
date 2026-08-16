import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerBackgroundTerminalsApplication } from "../src/application.ts";

describe("background terminal Pi registration", () => {
  it("defers the agent tool until session settings load and registers only /ps", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fixture = {
      registerTool: vi.fn((tool: { name: string }) => {
        tools.push(tool.name);
      }),
      registerCommand: vi.fn((name: string) => {
        commands.push(name);
      }),
      on: vi.fn((name: string) => {
        events.push(name);
      }),
    };
    // SAFETY: Registration uses only the three ExtensionAPI methods implemented here.
    const pi = fixture as typeof fixture & ExtensionAPI;

    registerBackgroundTerminalsApplication(pi);

    expect(tools).toEqual([]);
    expect(commands).toEqual(["ps"]);
    expect(events).toEqual(["session_start", "turn_end", "session_shutdown"]);
  });
});
