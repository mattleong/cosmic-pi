import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerBackgroundTerminalsApplication } from "../src/application.ts";

describe("background terminal Pi registration", () => {
  it("registers one agent tool and only the /ps human command", () => {
    const tools: Array<{ readonly name: string; readonly promptGuidelines?: readonly string[] }> =
      [];
    const commands: string[] = [];
    const events: string[] = [];
    const pi = {
      registerTool: vi.fn((tool: { name: string; promptGuidelines?: readonly string[] }) => {
        tools.push(tool);
      }),
      registerCommand: vi.fn((name: string) => {
        commands.push(name);
      }),
      on: vi.fn((name: string) => {
        events.push(name);
      }),
    } as unknown as ExtensionAPI;

    registerBackgroundTerminalsApplication(pi);

    expect(tools.map((tool) => tool.name)).toEqual(["background_terminal"]);
    expect(tools[0]?.promptGuidelines?.join(" ")).toContain("use bash");
    expect(commands).toEqual(["ps"]);
    expect(events).toEqual(["session_start", "turn_end", "session_shutdown"]);
  });
});
