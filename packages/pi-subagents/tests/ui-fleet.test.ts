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
      backend: "pi",
      capabilities: [
        "steer",
        "interrupt",
        "resume",
        "rename-display",
        "parent-contact",
        "peer-notice",
        "native-fork",
      ],
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
const completedProjection: SubagentProjection = {
  revision: 2,
  runs: [
    {
      ...projection.runs[0]!,
      state: "completed",
      endedAt: 2_000,
      lastActivityAt: 2_000,
      question: undefined,
    },
  ],
};

const makeComponent = (
  width: number,
  height: number,
  currentProjection: SubagentProjection = projection,
) => {
  const actions = {
    stop: vi.fn(),
    interrupt: vi.fn(),
    resume: vi.fn(),
    message: vi.fn(),
    rename: vi.fn(),
  };
  const component = new SubagentFleetComponent({
    theme,
    getProjection: () => currentProjection,
    getHeight: () => height,
    getNow: () => 20_000,
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

  it("shows completion age in fleet rows", () => {
    const { lines } = makeComponent(80, 18, completedProjection);
    expect(lines.join("\n")).toContain("completed 18s ago");
  });

  it("wraps structured narrow details without showing raw transcript duplicates", () => {
    const { component } = makeComponent(42, 24, completedProjection);
    component.handleInput("\r");
    const lines = component.render(42);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Activity");
    expect(rendered).toContain("Viewport-safe result.");
    expect(rendered).not.toContain("duplicate event");
    expect(rendered).not.toContain("Need a decision");
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);
  });

  it("scrolls detail output with ctrl+k and ctrl+j", () => {
    const { component } = makeComponent(42, 12, completedProjection);
    component.handleInput("\r");
    const bottom = component.render(42).join("\n");
    expect(bottom).toContain("of");
    expect(bottom).toContain("C-k up · C-j down");
    expect(bottom).toContain("Final report");

    for (let index = 0; index < 40; index += 1) component.handleInput("\u000b");
    const top = component.render(42).join("\n");
    expect(top).toContain("Task");
    expect(top).not.toBe(bottom);

    component.handleInput("\n");
    expect(component.render(42).join("\n")).not.toBe(top);
  });

  it("toggles technical details and responsive shortcut help", () => {
    const { component } = makeComponent(42, 24);
    component.handleInput("\r");
    expect(component.render(42).join("\n")).not.toContain("Technical details");
    component.handleInput("t");
    expect(component.render(42).join("\n")).toContain("Technical details");
    expect(component.render(42).at(-1)).toContain("? help");
    component.handleInput("?");
    expect(component.render(42).at(-1)).toContain("m msg");
  });

  it.each(["paused", "stopping"] as const)(
    "does not offer messaging while a run is %s",
    (state) => {
      const currentProjection: SubagentProjection = {
        revision: 3,
        runs: [{ ...projection.runs[0]!, state, question: undefined }],
      };
      const { actions, component } = makeComponent(80, 18, currentProjection);
      component.handleInput("m");
      expect(actions.message).not.toHaveBeenCalled();
    },
  );

  it("allows completed rename but does not offer terminal stop", () => {
    const { actions, component } = makeComponent(80, 18, completedProjection);
    component.handleInput("n");
    expect(actions.rename).toHaveBeenCalledWith("agent-1");
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
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
