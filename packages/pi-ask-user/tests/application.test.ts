import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerAskUserApplication } from "../src/application.ts";

describe("ask-user Pi registration", () => {
  it("defers tool registration until session startup and registers only its resume command", () => {
    const tools: string[] = [];
    const commands: string[] = [];
    const events: string[] = [];
    const fixture = {
      registerTool: vi.fn((tool: { name: string }) => tools.push(tool.name)),
      registerCommand: vi.fn((name: string) => commands.push(name)),
      on: vi.fn((name: string) => events.push(name)),
    };
    // SAFETY: Registration uses only the three ExtensionAPI methods implemented by this fixture.
    const pi = fixture as typeof fixture & ExtensionAPI;

    registerAskUserApplication(pi);

    expect(tools).toEqual([]);
    expect(commands).toEqual(["ask-user"]);
    expect(events).toEqual(["session_start", "session_shutdown"]);
  });
});
