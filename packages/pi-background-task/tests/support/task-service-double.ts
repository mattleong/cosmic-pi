// Owned task-service boundary double: explicit overrides, loud defects for every unused method.
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundTaskState,
  BackgroundTaskStatus,
  BackgroundTaskStatusWait,
} from "../../src/task/model.ts";
import {
  BackgroundTaskService,
  type BackgroundTaskServiceContract,
} from "../../src/task/service.ts";

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

/** Supplies what the shared executor reads: the task service and Path. */
export const provideTaskService =
  (service: BackgroundTaskServiceContract) =>
  <A, E>(effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>) =>
    effect.pipe(Effect.provideService(BackgroundTaskService, service), Effect.provide(Path.layer));

/** A tool runner over `service`, in the shape the application's session runner has. */
export const taskServiceRunner =
  (service: BackgroundTaskServiceContract) =>
  <A, E>(effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>, signal?: AbortSignal) =>
    Effect.runPromise(provideTaskService(service)(effect), signal ? { signal } : undefined);

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

/** A wait result over `snapshot`, read through its latest cursor unless `fields` say otherwise. */
export const taskWait = (
  snapshot: BackgroundTaskStatus,
  outcome: BackgroundTaskStatusWait["outcome"],
  fields: Partial<BackgroundTaskStatusWait> = {},
): BackgroundTaskStatusWait => ({
  id: snapshot.id,
  outcome,
  snapshot,
  nextCursor: snapshot.logCursor,
  earliestAvailableCursor: 1,
  droppedBytes: 0,
  appliedWaitSeconds: 30,
  ...fields,
});

/** A log slice whose lines hold consecutive cursors from `from`; `nextCursor` is the last one. */
export const taskLogSlice = (
  id: string,
  state: BackgroundTaskState,
  lines: ReadonlyArray<Pick<BackgroundLogEvent, "stream" | "text">>,
  { from = 1, droppedBytes = 0 }: { readonly from?: number; readonly droppedBytes?: number } = {},
): BackgroundLogSlice => ({
  id,
  state,
  nextCursor: from + lines.length - 1,
  earliestAvailableCursor: from,
  droppedBytes,
  events: lines.map((line, index) => ({
    ...line,
    cursor: from + index,
    timestamp: from + index,
    bytes: line.text.length,
  })),
});
