import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { BackgroundTerminalProjection } from "../src/job/model.ts";
import { ProcessManagerComponent, type ProcessManagerOptions } from "../src/ui/manager.ts";

const escapeKey = String.fromCharCode(27);
const ctrlU = String.fromCharCode(21);
const ctrlD = String.fromCharCode(4);
const pageDown = `${escapeKey}[6~`;

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

const logLines = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    cursor: index + 1,
    stream: "stdout" as const,
    text: `line-${index}\n`,
    timestamp: index,
    bytes: 8,
  }));

const makeComponent = (overrides: Partial<ProcessManagerOptions> = {}) => {
  const close = vi.fn();
  const stop = vi.fn();
  const clear = vi.fn();
  const component = new ProcessManagerComponent({
    theme,
    getProjection: () => projection,
    getHeight: () => 12,
    getNow: () => 0,
    requestRender: vi.fn(),
    close,
    stop,
    clear,
    ...overrides,
  });
  return { component, close, stop, clear };
};

const renderAt = (width: number, height: number) =>
  makeComponent({ getHeight: () => height }).component.render(width);

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
    const scrolling: BackgroundTerminalProjection = {
      jobs: [{ ...projection.jobs[0]!, logs: logLines(30), logCursor: 30 }],
    };
    const { component } = makeComponent({ getProjection: () => scrolling });
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
    const { component } = makeComponent({ getHeight: () => 18 });
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
    const current: BackgroundTerminalProjection = {
      jobs: [
        { ...projection.jobs[0]!, logs: logLines(30), logCursor: 30 },
        { ...projection.jobs[0]!, id: "term-2", name: "second" },
      ],
    };
    const { close, component } = makeComponent({ getProjection: () => current });
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
    const { component, stop } = makeComponent();
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

  it("uses Esc as back from the detail pane before closing the manager", () => {
    const { close, component } = makeComponent();
    component.render(42);
    component.handleInput("\r");
    expect(component.render(42).join("\n")).not.toContain("dev-server · running");
    component.handleInput(escapeKey);
    expect(component.render(42).join("\n")).toContain("dev-server · running");
    expect(close).not.toHaveBeenCalled();
    component.handleInput(escapeKey);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps unfollow sticky before overflow and returns to the bottom when follow toggles", () => {
    let current: BackgroundTerminalProjection = {
      jobs: [{ ...projection.jobs[0]!, logs: logLines(3), logCursor: 3 }],
    };
    const { component } = makeComponent({ getProjection: () => current });
    expect(component.render(80).at(-1)).toContain("f Unfollow");
    component.handleInput("f");
    expect(component.render(80).at(-1)).toContain("f Follow");

    // New lines arrive after the pre-overflow unfollow; the viewed top slice stays anchored.
    current = { jobs: [{ ...projection.jobs[0]!, logs: logLines(30), logCursor: 30 }] };
    const anchored = component.render(80).join("\n");
    expect(anchored).toContain("line-0");
    expect(anchored).not.toContain("line-29");

    // The anchor holds across further growth instead of drifting with the newest lines.
    current = { jobs: [{ ...projection.jobs[0]!, logs: logLines(40), logCursor: 40 }] };
    const stillAnchored = component.render(80).join("\n");
    expect(stillAnchored).toContain("line-0");
    expect(stillAnchored).not.toContain("line-39");

    component.handleInput("f");
    const following = component.render(80).join("\n");
    expect(following).toContain("line-39");
    expect(following).not.toContain("line-0 ");
  });

  it("does not silently re-follow when motions scroll back to the newest lines", () => {
    let current: BackgroundTerminalProjection = {
      jobs: [{ ...projection.jobs[0]!, logs: logLines(30), logCursor: 30 }],
    };
    const { component } = makeComponent({ getProjection: () => current });
    component.render(80);
    component.handleInput("f");
    component.handleInput("l");
    expect(component.render(80).at(-1)).toContain("f Follow");
    component.handleInput(ctrlU);
    component.render(80);
    component.handleInput(ctrlD);
    expect(component.render(80).at(-1)).toContain("f Follow");

    // Back at the bottom but still unfollowed: new lines keep the viewed slice anchored.
    current = { jobs: [{ ...projection.jobs[0]!, logs: logLines(35), logCursor: 35 }] };
    const anchored = component.render(80).join("\n");
    expect(anchored).toContain("line-29");
    expect(anchored).not.toContain("line-34");
  });

  it("pages the stacked list by its rendered rows instead of the full height", () => {
    const jobs = Array.from({ length: 20 }, (_, index) => ({
      ...projection.jobs[0]!,
      id: `term-${index}`,
      name: `job-${index}`,
    }));
    const { component } = makeComponent({ getProjection: () => ({ jobs }) });
    component.render(80);
    component.handleInput(pageDown);
    const paged = component.render(80).join("\n");
    expect(paged).toContain("> ⠋ job-3");
    component.handleInput(ctrlD);
    expect(component.render(80).join("\n")).toContain("> ⠋ job-4");
  });
});
