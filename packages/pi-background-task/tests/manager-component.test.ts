// Behavior-first component tests for the /tasks manager: two-press stop, stale-selection
// safety, sticky unfollow, narrow-only Enter policy, and selection reconciliation.
// Assertions use transitions, callbacks, and coarse content markers — never exact
// copy, colors, or layout.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import type { BackgroundTaskView, BackgroundLogEvent } from "../src/task/model.ts";
import { TaskManagerComponent } from "../src/ui/manager.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used here.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

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

const makeManager = (initial: ReadonlyArray<BackgroundTaskView>, height = 8) => {
  let tasks = initial;
  const stop = vi.fn();
  const clear = vi.fn();
  const close = vi.fn();
  const component = new TaskManagerComponent({
    theme,
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
    stop,
    clear,
    close,
    setTasks: (next: ReadonlyArray<BackgroundTaskView>) => {
      tasks = next;
    },
  };
};

const ESC = "\x1b";
const ENTER = "\r";

describe("/tasks stop confirmation", () => {
  it("stops a task only on the second x press", () => {
    const { component, stop } = makeManager([task("a")]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("a");
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

describe("/tasks follow", () => {
  it("keeps the viewed slice sticky after unfollow and returns to the newest on refollow", () => {
    const { component, setTasks } = makeManager([task("a", { logs: logEvents(20) })]);
    expect(component.render(120).join("\n")).toContain("line-20");

    component.handleInput("f");
    setTasks([task("a", { logs: logEvents(25) })]);
    const anchored = component.render(120).join("\n");
    expect(anchored).toContain("line-20");
    expect(anchored).not.toContain("line-25");

    component.handleInput("f");
    expect(component.render(120).join("\n")).toContain("line-25");
  });
});

describe("/tasks narrow layout", () => {
  it("opens the inspector on Enter, returns on Esc, and closes on the next Esc", () => {
    const { component, close } = makeManager([task("a", { logs: logEvents(3) })]);
    expect(component.render(50).join("\n")).not.toContain("line-3");

    component.handleInput(ENTER);
    expect(component.render(50).join("\n")).toContain("line-3");

    component.handleInput(ESC);
    expect(close).not.toHaveBeenCalled();
    expect(component.render(50).join("\n")).not.toContain("line-3");

    component.handleInput(ESC);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps Enter inert outside the narrow layout while pane focus still uses h/l", () => {
    const focus = makeManager([task("a")]);
    focus.component.render(120);
    focus.component.handleInput("l");
    focus.component.handleInput(ESC);
    expect(focus.close).not.toHaveBeenCalled();

    const inert = makeManager([task("a")]);
    inert.component.render(120);
    inert.component.handleInput(ENTER);
    inert.component.handleInput(ESC);
    expect(inert.close).toHaveBeenCalledTimes(1);
  });
});
