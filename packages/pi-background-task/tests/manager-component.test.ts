import { describe, expect, it, vi } from "@effect/vitest";
import { formatBytes } from "pi-cosmic-core";
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

const ESCAPE = "\u001b";

const makeManager = (initial: ReadonlyArray<BackgroundTaskView>) => {
  let tasks = initial;
  const stop = vi.fn();
  const clear = vi.fn();
  const close = vi.fn();
  const component = new TaskManagerComponent({
    theme: plainTheme,
    getProjection: () => ({ tasks }),
    getHeight: () => 12,
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
    render: () => component.render(120).join("\n"),
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

describe("/tasks clear confirmation", () => {
  const finished = [task("a"), task("b", { state: "exited", exitCode: 0, endedAt: 5 })];

  it("clears finished tasks only after the same key confirms", () => {
    const { component, clear } = makeManager(finished);
    component.handleInput("c");
    expect(clear).not.toHaveBeenCalled();
    component.handleInput("c");
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending clear without closing the manager", () => {
    const { component, clear, close } = makeManager(finished);
    component.handleInput("c");
    component.handleInput(ESCAPE);
    expect(clear).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    // The cancelled confirmation leaves ordinary navigation, where q closes.
    component.handleInput("q");
    expect(clear).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("offers no clear while every task is still active", () => {
    const { component, clear } = makeManager([task("a")]);
    component.handleInput("c");
    component.handleInput("c");
    expect(clear).not.toHaveBeenCalled();
  });
});

describe("/tasks finished-task details", () => {
  it("shows how a finished task ended", () => {
    for (const [ended, facts] of [
      [{ state: "failed", exitCode: 137, endedAt: 5 }, ["137"]],
      [{ state: "stopped", exitCode: null, signal: "SIGTERM", endedAt: 5 }, ["SIGTERM"]],
      [
        {
          state: "failed",
          exitCode: 1,
          failureCause: "FAIL tests/auth.test.ts > adds",
          endedAt: 5,
        },
        ["FAIL tests/auth.test.ts > adds"],
      ],
      [{ state: "failed", error: "Couldn't start the process", endedAt: 0 }, ["start the process"]],
      // All of its output was removed to fit the shared budget; the loss is still reported.
      [{ state: "exited", exitCode: 0, endedAt: 5, droppedLogBytes: 4_096 }, [formatBytes(4_096)]],
    ] as const) {
      const { render } = makeManager([task("a", ended)]);
      const screen = render();
      for (const fact of facts) expect(screen).toContain(fact);
    }
  });
});
