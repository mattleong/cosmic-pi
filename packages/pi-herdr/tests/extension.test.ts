import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import herdrExtension from "../src/extension.ts";

const host = () => {
  const events: string[] = [];
  const commands: string[] = [];
  const pi = {
    registerCommand: vi.fn((name: string) => commands.push(name)),
    registerTool: vi.fn(),
    on: vi.fn((name: string) => events.push(name)),
    getActiveTools: vi.fn(() => []),
    setActiveTools: vi.fn(),
  } as unknown as ExtensionAPI;
  return { pi, events, commands };
};

afterEach(() => vi.unstubAllEnvs());

describe("pi-herdr extension registration", () => {
  it("registers nothing inside a pi-subagents child process", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "1");
    const { pi, events, commands } = host();

    herdrExtension(pi);

    expect(commands).toEqual([]);
    expect(events).toEqual([]);
    expect(pi.registerTool).not.toHaveBeenCalled();
  });

  it("registers the normal application outside a pi-subagents child process", () => {
    vi.stubEnv("PI_SUBAGENT_CHILD", "0");
    const { pi, events, commands } = host();

    herdrExtension(pi);

    expect(commands).toEqual(["herdr"]);
    expect(events).toEqual(["session_start", "turn_end", "session_tree", "session_shutdown"]);
  });
});
