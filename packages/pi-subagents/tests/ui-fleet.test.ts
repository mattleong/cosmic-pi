import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { SubagentProjection } from "../src/run/model.ts";
import { SubagentFleetComponent } from "../src/ui/fleet.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const projection: SubagentProjection = {
  revision: 1,
  runs: [
    {
      id: "agent-1",
      name: "auth-reader",
      task: "Review authentication",
      cwd: "/project",
      state: "waiting_for_parent",
      execution: "background",
      context: "fresh",
      writeIntent: "read-only",
      model: "openai-codex/gpt-5.6-sol",
      effort: "high",
      startedAt: 1,
      lastActivityAt: 2,
      question: { requestId: "q-1", message: "Which API?", createdAt: 2 },
      transcript: ["Read auth.ts", "Need a decision"],
      sessionEvents: [
        {
          type: "tool",
          toolCallId: "tool-1",
          toolName: "read",
          target: `${"nested/path/".repeat(12)}auth.ts`,
          state: "completed",
          startedAt: 1,
          endedAt: 2,
        },
        { type: "assistant", text: "This duplicate event should stay hidden.", createdAt: 2 },
      ],
      finalText: "## Answer\n\nViewport-safe result.",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: 0.001 },
    },
  ],
};

const makeComponent = (width: number, height: number) => {
  const actions = {
    stop: vi.fn(),
    interrupt: vi.fn(),
    resume: vi.fn(),
    message: vi.fn(),
    rename: vi.fn(),
  };
  const component = new SubagentFleetComponent({
    theme,
    getProjection: () => projection,
    getHeight: () => height,
    requestRender: vi.fn(),
    close: vi.fn(),
    actions,
  });
  return { actions, lines: component.render(width), component };
};

describe("/subagents fleet UI", () => {
  beforeAll(() => initTheme("dark", false));

  it.each([
    [120, 24],
    [80, 18],
    [42, 12],
  ])("renders width-safe responsive output at %sx%s", (width, height) => {
    const { lines } = makeComponent(width, height);
    expect(lines).toHaveLength(height);
    expect(lines.join("\n")).toContain("auth-reader");
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("wraps structured narrow details without showing raw transcript duplicates", () => {
    const { component } = makeComponent(42, 24);
    component.handleInput("\r");
    const lines = component.render(42);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Session output");
    expect(rendered).toContain("Viewport-safe result.");
    expect(rendered).not.toContain("duplicate event");
    expect(rendered).not.toContain("Need a decision");
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
  });

  it("routes message, interrupt, rename, and confirmed stop controls", () => {
    const { actions, component } = makeComponent(80, 18);
    component.handleInput("m");
    expect(actions.message).toHaveBeenCalledWith("agent-1", true);
    component.handleInput("i");
    expect(actions.interrupt).toHaveBeenCalledWith("agent-1");
    component.handleInput("n");
    expect(actions.rename).toHaveBeenCalledWith("agent-1");
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith("agent-1");
  });
});
