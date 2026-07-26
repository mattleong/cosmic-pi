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
    expect(lines.join("\n")).toContain("finished 18s ago");
  });

  it.each(["\r", "\n", "\u001b[13u"])("toggles narrow details with each Enter encoding", (key) => {
    const { component } = makeComponent(42, 24, completedProjection);
    component.handleInput(key);
    expect(component.render(42).join("\n")).toContain("Final report");
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

  it("scrolls detail output with ctrl+u and ctrl+d", () => {
    const { component } = makeComponent(42, 12, completedProjection);
    component.handleInput("\r");
    const bottom = component.render(42).join("\n");
    expect(bottom).toContain("of");
    expect(bottom).toContain("C-u up · C-d down");
    expect(bottom).toContain("Final report");

    for (let index = 0; index < 40; index += 1) component.handleInput("\u0015");
    const top = component.render(42).join("\n");
    expect(top).toContain("Task");
    expect(top).not.toBe(bottom);

    component.handleInput("\u0004");
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
    expect(component.render(42).at(-1)).toContain("m reply");
  });

  it.each([120, 80])("does not reset detail scrolling with Enter at width %s", (width) => {
    const { component } = makeComponent(width, 12, completedProjection);
    for (let index = 0; index < 20; index += 1) component.handleInput("\u0015");
    const before = component.render(width).join("\n");
    component.handleInput("\r");
    expect(component.render(width).join("\n")).toBe(before);
  });

  it("clears pending stop confirmation when selection changes", () => {
    const twoRuns: SubagentProjection = {
      revision: 4,
      runs: [projection.runs[0]!, { ...projection.runs[0]!, id: "agent-2", name: "second-reader" }],
    };
    const { actions, component } = makeComponent(80, 18, twoRuns);
    component.handleInput("x");
    expect(component.render(80).at(-1)).toContain("confirm stop agent-1");
    component.handleInput("j");
    expect(component.render(80).at(-1)).not.toContain("confirm stop agent-1");
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
    expect(component.render(80).at(-1)).toContain("confirm stop agent-2");
  });

  it("shows only supported actions for Claude runs", () => {
    const claudeRunning: SubagentProjection = {
      revision: 5,
      runs: [
        {
          ...projection.runs[0]!,
          backend: "claude-cli",
          model: "opus",
          capabilities: ["resume", "rename-display"],
          state: "running",
          question: undefined,
        },
      ],
    };
    const running = makeComponent(120, 18, claudeRunning);
    const runningHelp = running.component.render(120).at(-1) ?? "";
    expect(runningHelp).toContain("n rename");
    expect(runningHelp).toContain("x stop");
    expect(runningHelp).not.toContain("m message");
    expect(runningHelp).not.toContain("i interrupt");
    running.component.handleInput("m");
    running.component.handleInput("i");
    expect(running.actions.message).not.toHaveBeenCalled();
    expect(running.actions.interrupt).not.toHaveBeenCalled();

    const completed = makeComponent(120, 18, {
      revision: 6,
      runs: [{ ...claudeRunning.runs[0]!, state: "completed", endedAt: 2_000 }],
    });
    const completedHelp = completed.component.render(120).at(-1) ?? "";
    expect(completedHelp).toContain("r resume");
    expect(completedHelp).toContain("n rename");
    expect(completedHelp).not.toContain("x stop");
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
