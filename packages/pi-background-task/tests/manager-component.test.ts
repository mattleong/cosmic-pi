import { describe, expect, it, vi } from "@effect/vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { BackgroundTaskView } from "../src/task/model.ts";
import { TaskManagerComponent } from "../src/ui/manager.ts";

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
  let currentHeight = height;
  const stop = vi.fn();
  const clear = vi.fn();
  const close = vi.fn();
  const component = new TaskManagerComponent({
    theme: managerTheme,
    getProjection: () => ({ tasks }),
    getHeight: () => currentHeight,
    getNow: () => 1_000,
    requestRender: () => {},
    close,
    stop,
    clear,
  });
  return {
    component,
    setHeight: (next: number) => {
      currentHeight = next;
    },
    stop,
    clear,
    close,
    setTasks: (next: ReadonlyArray<BackgroundTaskView>) => {
      tasks = next;
    },
  };
};

describe("/tasks stop confirmation", () => {
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
