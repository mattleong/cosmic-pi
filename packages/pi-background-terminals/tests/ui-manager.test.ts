import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundTerminalProjection } from "../src/job/model.ts";
import { ProcessManagerComponent } from "../src/ui/manager.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as unknown as Theme;

const projection: BackgroundTerminalProjection = {
  jobs: [
    {
      id: "term-1",
      name: "dev-server",
      command: "npm run dev",
      cwd: "/project",
      state: "running",
      pid: 123,
      startedAt: 0,
      logCursor: 1,
      droppedLogBytes: 0,
      logs: [{ cursor: 1, stream: "stdout", text: "ready\n", timestamp: 1, bytes: 6 }],
    },
  ],
};

const renderAt = (width: number, height: number) => {
  const component = new ProcessManagerComponent({
    theme,
    getProjection: () => projection,
    getHeight: () => height,
    getNow: () => 0,
    requestRender: vi.fn(),
    close: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
  });
  return component.render(width);
};

describe("/ps process manager", () => {
  it("uses the full requested height and respects wide line width", () => {
    const lines = renderAt(120, 24);
    expect(lines).toHaveLength(24);
    expect(lines.join("\n")).toContain("dev-server");
    expect(lines.join("\n")).toContain("ready");
    expect(lines.every((line) => visibleWidth(line) <= 120)).toBe(true);
  });

  it("uses the same grouped responsive footer as the subagent fleet", () => {
    const footer = renderAt(120, 24).at(-1) ?? "";
    expect(footer).toContain("↑↓ Select · C-u/d Scroll");
    expect(footer).toContain("f Unfollow · x Stop");
    expect(footer).toContain("t Technical · ? Help · Esc Close");
    expect(footer).not.toContain("c Clear");
  });

  it("renders width- and height-safe narrow fallbacks", () => {
    const lines = renderAt(42, 12);
    expect(lines).toHaveLength(12);
    expect(lines.join("\n")).toContain("⠋ dev-server · running · 0s");
    expect(lines.join("\n")).not.toContain("term-1");
    expect(lines.every((line) => visibleWidth(line) <= 42)).toBe(true);

    const tiny = renderAt(12, 4);
    expect(tiny).toHaveLength(4);
    expect(tiny.every((line) => visibleWidth(line) <= 12)).toBe(true);
  });

  it.each([
    ["starting", "accent", "◌"],
    ["running", "success", "⠋"],
    ["stopping", "warning", "◐"],
    ["exited", "success", "✓"],
    ["failed", "error", "×"],
    ["stopped", "muted", "■"],
    ["timed_out", "error", "⧖"],
  ] as const)("renders the %s status icon in %s", (state, color, glyph) => {
    const fg = vi.fn((_color: string, text: string) => text);
    const stateProjection: BackgroundTerminalProjection = {
      ...projection,
      jobs: [{ ...projection.jobs[0]!, state }],
    };
    const component = new ProcessManagerComponent({
      theme: { fg } as unknown as Theme,
      getProjection: () => stateProjection,
      getHeight: () => 12,
      getNow: () => 0,
      requestRender: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    });

    component.render(42);

    expect(fg).toHaveBeenCalledWith(color, glyph);
  });

  it("animates running rows with the shared Braille frames", () => {
    const component = new ProcessManagerComponent({
      theme,
      getProjection: () => projection,
      getHeight: () => 12,
      getNow: () => 320,
      requestRender: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    });
    expect(component.render(42).join("\n")).toContain("⠹ dev-server");
  });

  it("scrolls narrow log details with Ctrl-U and Ctrl-D", () => {
    const logs = Array.from({ length: 30 }, (_, index) => ({
      cursor: index + 1,
      stream: "stdout" as const,
      text: `line-${index}\n`,
      timestamp: index,
      bytes: 8,
    }));
    const scrolling: BackgroundTerminalProjection = {
      jobs: [{ ...projection.jobs[0]!, logs, logCursor: 30 }],
    };
    const component = new ProcessManagerComponent({
      theme,
      getProjection: () => scrolling,
      getHeight: () => 12,
      getNow: () => 0,
      requestRender: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    });
    component.render(42);
    component.handleInput("\r");
    const tail = component.render(42).join("\n");
    expect(tail).toContain("line-29");
    component.handleInput("\u0015");
    expect(component.render(42).join("\n")).not.toBe(tail);
    component.handleInput("\u0004");
    expect(component.render(42).join("\n")).toBe(tail);
  });

  it("uses in-manager stop confirmation and Enter details", () => {
    const stop = vi.fn();
    const requestRender = vi.fn();
    const component = new ProcessManagerComponent({
      theme,
      getProjection: () => projection,
      getHeight: () => 12,
      getNow: () => 0,
      requestRender,
      close: vi.fn(),
      stop,
      clear: vi.fn(),
    });
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).toHaveBeenCalledWith("term-1");
    component.handleInput("\r");
    expect(component.render(42).join("\n")).toContain("ready");
    expect(component.render(42).join("\n")).not.toContain("term-1");
    component.handleInput("t");
    expect(component.render(42).join("\n")).toContain("ID term-1");
  });
});
