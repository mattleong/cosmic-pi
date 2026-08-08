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

    component.handleInput("\u001b[5~");
    const paged = component.render(42).join("\n");
    expect(paged).not.toBe(tail);
    component.handleInput("\u001b[6~");
    expect(component.render(42).join("\n")).toBe(tail);
  });

  it("mentions PgUp/PgDn paging in the expanded ? help while collapsed help stays compact", () => {
    const component = new ProcessManagerComponent({
      theme,
      getProjection: () => projection,
      getHeight: () => 18,
      getNow: () => 0,
      requestRender: vi.fn(),
      close: vi.fn(),
      stop: vi.fn(),
      clear: vi.fn(),
    });
    expect(component.render(120).at(-1) ?? "").not.toContain("PgUp/PgDn");
    component.handleInput("?");
    const expanded = component.render(120).at(-1) ?? "";
    expect(expanded).toContain("C-u/d Half");
    expect(expanded).toContain("PgUp/PgDn Page");
    expect(expanded).toContain("? Back");
    component.handleInput("?");
    expect(component.render(120).at(-1) ?? "").not.toContain("PgUp/PgDn");
  });

  it("supports gg/G endpoints, h/l panes, and q close", () => {
    const logs = Array.from({ length: 30 }, (_, index) => ({
      cursor: index + 1,
      stream: "stdout" as const,
      text: `line-${index}\n`,
      timestamp: index,
      bytes: 8,
    }));
    const current: BackgroundTerminalProjection = {
      jobs: [
        { ...projection.jobs[0]!, logs, logCursor: 30 },
        { ...projection.jobs[0]!, id: "term-2", name: "second" },
      ],
    };
    const close = vi.fn();
    const component = new ProcessManagerComponent({
      theme,
      getProjection: () => current,
      getHeight: () => 12,
      getNow: () => 0,
      requestRender: vi.fn(),
      close,
      stop: vi.fn(),
      clear: vi.fn(),
    });
    component.render(42);
    component.handleInput("G");
    component.handleInput("x");
    expect(component.render(42).at(-1)).toContain("term-2");
    component.handleInput("\u001b");
    component.handleInput("g");
    component.handleInput("g");
    component.handleInput("l");
    component.render(42);
    component.handleInput("g");
    component.handleInput("g");
    expect(component.render(42).join("\n")).toContain("line-0");
    component.handleInput("G");
    expect(component.render(42).join("\n")).toContain("line-29");
    component.handleInput("q");
    expect(close).toHaveBeenCalledTimes(1);
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
    component.handleInput("\u001b[120;1:2u");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    component.handleInput("x");
    expect(stop).toHaveBeenCalledWith("term-1");
    component.handleInput("\r");
    expect(component.render(42).join("\n")).toContain("ready");
    expect(component.render(42).join("\n")).not.toContain("term-1");
    component.handleInput("t");
    expect(component.render(42).join("\n")).toContain("ID term-1");
  });
});
