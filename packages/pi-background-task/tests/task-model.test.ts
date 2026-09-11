import { describe, expect, it } from "@effect/vitest";
import {
  countTaskStates,
  footerStatus,
  type BackgroundTaskState,
  type BackgroundTaskView,
} from "../src/task/model.ts";

const task = (state: BackgroundTaskState): BackgroundTaskView => ({
  id: "task-1",
  command: "test-command",
  cwd: "/tmp",
  state,
  startedAt: 0,
  logCursor: 0,
  droppedLogBytes: 0,
  logs: [],
});

const settledTasks = [task("exited"), task("stopped"), task("failed"), task("timed_out")];

describe("background-task footer policy", () => {
  it("clears when no active tasks remain, even with retained failures", () => {
    expect(footerStatus({ tasks: [] })).toBeUndefined();
    expect(footerStatus({ tasks: settledTasks })).toBeUndefined();
    // Hiding terminal tasks in the footer must not discard the manager's failure counts.
    expect(countTaskStates(settledTasks)).toEqual({ active: 0, failed: 2 });
  });

  it.each(["starting", "running", "stopping"] as const)(
    "keeps %s tasks visible without reminders about settled tasks",
    (state) => {
      const tasks = [task(state)];
      const activeStatus = footerStatus({ tasks });
      expect(activeStatus).toBeDefined();
      expect(footerStatus({ tasks: [...tasks, ...settledTasks] })).toBe(activeStatus);
    },
  );
});
