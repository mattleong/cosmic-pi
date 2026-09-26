// Behavior-first component tests for the /tasks manager: two-press stop, stale-selection
// safety, sticky unfollow, inspector navigation, and selection reconciliation.
// Assertions use transitions, callbacks, and coarse content markers — never exact
// copy, colors, or layout.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { BackgroundTaskView, BackgroundLogEvent } from "../src/task/model.ts";
import { TaskManagerComponent } from "../src/ui/manager.ts";

const logEvents = (count: number): BackgroundLogEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    cursor: index + 1,
    stream: "stdout",
    text: `line-${index + 1}\n`,
    timestamp: 0,
    bytes: 1,
  }));

const task = (id: string, overrides: Partial<BackgroundTaskView> = {}): BackgroundTaskView => ({
  id,
  name: id,
  command: `${id}-command`,
  cwd: "/tmp",
  state: "running",
  startedAt: 0,
  logCursor: 0,
  droppedLogBytes: 0,
  logs: [],
  ...overrides,
});

const makeManager = (
  initial: ReadonlyArray<BackgroundTaskView>,
  height = 8,
  managerTheme = plainTheme,
) => {
  let tasks = initial;
  const stop = vi.fn();
  const clear = vi.fn();
  const close = vi.fn();
  const component = new TaskManagerComponent({
    theme: managerTheme,
    getProjection: () => ({ tasks }),
    getHeight: () => height,
    getNow: () => 1_000,
    requestRender: () => {},
    close,
    stop,
    clear,
  });
  return {
    component,
    setHeight: (next: number) => {
      height = next;
    },
    stop,
    clear,
    close,
    setTasks: (next: ReadonlyArray<BackgroundTaskView>) => {
      tasks = next;
    },
  };
};

it("keeps the selected row reachable through live shrinking and growing", () => {
  const fixture = makeManager(
    Array.from({ length: 40 }, (_, index) => task(`item-${index}`)),
    32,
  );
  fixture.component.render(128);
  fixture.component.handleInput("G");
  for (const [width, height] of [
    [80, 16],
    [128, 32],
    [100, 24],
  ]) {
    fixture.setHeight(height!);
    fixture.component.invalidate();
    const lines = fixture.component.render(width!);
    expect(lines.length).toBeLessThanOrEqual(height!);
    expect(lines.join("\n")).toContain("item-39");
  }
  fixture.component.handleInput("x");
  fixture.component.handleInput("x");
  expect(fixture.stop).toHaveBeenCalledWith("item-39");
  expect(fixture.close).not.toHaveBeenCalled();
});

const ESC = "\x1b";
const ENTER = "\r";

describe("/tasks stop confirmation", () => {
  it("accepts Enter and ignores unrelated input while confirmation is pending", () => {
    const { component, stop } = makeManager([task("a")]);
    component.handleInput("x");
    component.handleInput("z");
    component.handleInput(ENTER);
    expect(stop).toHaveBeenCalledWith("a");
  });

  it("sanitizes the pending task identity in the confirmation footer", () => {
    const { component } = makeManager([task("\x1b[31mbad\nidentity")]);
    component.handleInput("x");

    const rendered = component.render(120);
    expect(rendered.some((line) => line.includes("Confirm stop bad identity"))).toBe(true);
    expect(rendered.every((line) => !line.includes("\x1b[31m"))).toBe(true);
  });

  it("cancels a pending stop on Esc without closing the manager", () => {
    const { component, stop, close } = makeManager([task("a")]);
    component.handleInput("x");
    component.handleInput(ESC);
    expect(stop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("never stops a stale selection after the projection replaces the selected task", () => {
    const { component, stop, setTasks } = makeManager([task("a"), task("b")]);
    component.handleInput("x");
    setTasks([task("b")]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
  });

  it("drops a pending stop when the selected task leaves an active state", () => {
    const { component, stop, setTasks } = makeManager([task("a")]);
    component.handleInput("x");
    setTasks([task("a", { state: "exited", endedAt: 5 })]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("/tasks theme invalidation", () => {
  it("restyles an unchanged log snapshot after invalidation", () => {
    const oldStyle = vi.fn((text: string) => `old-style${text}`);
    const newStyle = vi.fn((text: string) => `new-style${text}`);
    let errorStyle = oldStyle;
    // SAFETY: This fixture supplies the theme methods used by the manager.
    const mutableTheme = {
      bold: plainTheme.bold,
      fg: (color: string, text: string) => (color === "error" ? errorStyle(text) : text),
    } as Theme;
    const logs = Object.freeze(
      logEvents(1).map((event) => ({ ...event, stream: "stderr" as const })),
    );
    const { component } = makeManager([task("a", { logs })], 8, mutableTheme);
    const logRow = () => component.render(120).find((line) => line.includes("line-1"));

    expect(logRow()).toContain("old-style");
    expect(oldStyle).toHaveBeenCalled();
    errorStyle = newStyle;
    expect(logRow()).toContain("old-style");
    expect(newStyle).not.toHaveBeenCalled();

    component.invalidate();

    const refreshed = logRow();
    expect(newStyle).toHaveBeenCalled();
    expect(refreshed).toContain("new-style");
    expect(refreshed).not.toContain("old-style");
  });
});

describe("/tasks follow", () => {
  it("keeps the viewed slice sticky after unfollow and returns to the newest on refollow", () => {
    const { component, setTasks } = makeManager([task("a", { logs: logEvents(20) })]);
    expect(component.render(120).join("\n")).toContain("line-20");

    component.handleInput("f");
    component.handleInput(ENTER);
    component.handleInput(ENTER);
    setTasks([task("a", { logs: logEvents(25) })]);
    const anchored = component.render(120).join("\n");
    expect(anchored).toContain("line-20");
    expect(anchored).not.toContain("line-25");
    component.handleInput(ENTER);
    expect(component.render(120).join("\n")).toContain("line-20");

    component.handleInput("f");
    expect(component.render(120).join("\n")).toContain("line-25");
  });
});

describe("/tasks narrow layout", () => {
  it.each([
    ["Esc/Enter", ESC, ENTER],
    ["h/l", "h", "l"],
  ])("preserves unfollowed output across %s pane transitions", (_label, back, inspect) => {
    const { component, setTasks } = makeManager([task("a", { logs: logEvents(25) })]);
    const visibleLogs = () =>
      component
        .render(50)
        .join("\n")
        .match(/line-\d+/g) ?? [];
    component.render(50);
    component.handleInput(ENTER);
    const viewed = visibleLogs();
    expect(viewed).toContain("line-25");
    component.handleInput("f");
    expect(visibleLogs()).toEqual(viewed);

    component.handleInput(back);
    expect(visibleLogs()).toEqual([]);
    component.handleInput(inspect);
    expect(visibleLogs()).toEqual(viewed);

    component.handleInput(back);
    visibleLogs();
    setTasks([task("a", { logs: logEvents(30) })]);
    expect(visibleLogs()).toEqual([]);
    component.handleInput(inspect);
    expect(visibleLogs()).toEqual(viewed);
    setTasks([task("a", { logs: logEvents(35) })]);
    expect(visibleLogs()).toEqual(viewed);

    component.handleInput("f");
    expect(visibleLogs()).toContain("line-35");
  });

  it.each([59, 60, 80, 99, 100])(
    "Enter inspects and Esc returns across resize at %s columns",
    (width) => {
      const { component, close, stop } = makeManager([task("a"), task("b")], 20);
      component.render(width);
      component.handleInput("j");
      component.handleInput(ENTER);
      component.handleInput(ENTER);
      component.render(width === 59 ? 100 : 59);
      component.handleInput(ESC);
      expect(close).not.toHaveBeenCalled();
      component.render(59);
      component.handleInput("x");
      component.handleInput("x");
      expect(stop).toHaveBeenCalledWith("b");
      component.handleInput(ESC);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it.each([59, 60, 80, 99, 100])("makes long metadata reachable at %s columns", (width) => {
    const command = "工具".repeat(100) + "COMMAND-END";
    const cwd = "/" + "路径/".repeat(100) + "DIRECTORY-END";
    const { component } = makeManager([task("a", { command, cwd })], 16);
    component.render(width);
    component.handleInput(ENTER);
    component.handleInput("t");
    let seen = component.render(width).join("\n");
    component.handleInput("g");
    component.handleInput("g");
    for (let index = 0; index < 100; index += 1) {
      seen += component.render(width).join("\n");
      component.handleInput("j");
    }
    expect(seen).toContain("COMMAND-END");
    expect(seen).toContain("DIRECTORY-END");
  });
});
