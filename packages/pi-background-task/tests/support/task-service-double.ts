// Owned task-service boundary double: explicit overrides, loud defects for every unused method.
import * as Effect from "effect/Effect";
import type { BackgroundTaskStatus } from "../../src/task/model.ts";
import type { BackgroundTaskServiceContract } from "../../src/task/service.ts";

const unexpected = (method: keyof BackgroundTaskServiceContract): Effect.Effect<never> =>
  Effect.die(new Error(`Unexpected BackgroundTaskService.${method} call in test fixture.`));

/** Completes a partial service double; any method a test did not supply is a defect. */
export const taskServiceDouble = (
  base: Partial<BackgroundTaskServiceContract>,
): BackgroundTaskServiceContract => ({
  start: base.start ?? (() => unexpected("start")),
  list: base.list ?? (() => unexpected("list")),
  status: base.status ?? (() => unexpected("status")),
  logs: base.logs ?? (() => unexpected("logs")),
  wait: base.wait ?? (() => unexpected("wait")),
  stop: base.stop ?? (() => unexpected("stop")),
  stopAll: base.stopAll ?? (() => unexpected("stopAll")),
  clear: base.clear ?? unexpected("clear"),
});

/** A service snapshot with neutral defaults; tests state only the fields they exercise. */
export const taskStatus = (
  task: Pick<BackgroundTaskStatus, "id" | "state"> & Partial<BackgroundTaskStatus>,
): BackgroundTaskStatus => ({
  command: "pnpm test",
  cwd: "/project",
  startedAt: 1,
  logCursor: 0,
  droppedLogBytes: 0,
  ...task,
});
