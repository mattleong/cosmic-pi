import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { utf8ByteLength } from "pi-cosmic-core";
import type {
  BackgroundLogEvent,
  BackgroundLogSlice,
  BackgroundOutputSkip,
  BackgroundTaskLogs,
  BackgroundTaskState,
  BackgroundTaskStatus,
  BackgroundTaskStatusWait,
  BackgroundTaskStopResult,
} from "../../src/task/model.ts";
import {
  BackgroundTaskService,
  type BackgroundTaskServiceContract,
} from "../../src/task/service.ts";

const unexpected = (method: keyof BackgroundTaskServiceContract): Effect.Effect<never> =>
  Effect.die(new Error(`Unexpected BackgroundTaskService.${method} call in test fixture.`));

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

export const provideTaskService =
  (service: BackgroundTaskServiceContract) =>
  <A, E>(effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>) =>
    effect.pipe(Effect.provideService(BackgroundTaskService, service), Effect.provide(Path.layer));

export const taskServiceRunner =
  (service: BackgroundTaskServiceContract) =>
  <A, E>(effect: Effect.Effect<A, E, BackgroundTaskService | Path.Path>, signal?: AbortSignal) =>
    Effect.runPromise(provideTaskService(service)(effect), signal ? { signal } : undefined);

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

export const taskWait = (
  snapshot: BackgroundTaskStatus,
  outcome: BackgroundTaskStatusWait["outcome"],
  fields: Partial<BackgroundTaskStatusWait> = {},
): BackgroundTaskStatusWait => ({
  id: snapshot.id,
  outcome,
  snapshot,
  nextCursor: snapshot.logCursor,
  earliestAvailableCursor: 0,
  droppedBytes: 0,
  appliedWaitSeconds: 30,
  recent: taskLogSlice(snapshot.id, snapshot.state, []),
  ...fields,
});

export const taskStop = (
  snapshot: BackgroundTaskStatus,
  alreadyFinished = false,
): BackgroundTaskStopResult => ({ snapshot, alreadyFinished });

type LogTask = BackgroundTaskLogs["task"];

/** A log read of `slice` from the task `task` names; only its name and command are kept. */
export const taskLogs = (
  slice: BackgroundLogSlice,
  { name, command }: LogTask = { command: "pnpm test" },
): BackgroundTaskLogs => ({ ...slice, task: { ...(name !== undefined && { name }), command } });

export const taskLogSlice = (
  id: string,
  state: BackgroundTaskState,
  lines: ReadonlyArray<Pick<BackgroundLogEvent, "stream" | "text">>,
  {
    from = 1,
    droppedBytes = 0,
    discardedBefore,
    task,
  }: {
    readonly from?: number;
    readonly droppedBytes?: number;
    /** Discarded output the read asked for before the first line, such as evicted output. */
    readonly discardedBefore?: BackgroundOutputSkip;
    readonly task?: LogTask;
  } = {},
): BackgroundTaskLogs => {
  const events = Arr.map(lines, (line, index) => ({
    ...line,
    cursor: from + index,
    timestamp: from + index,
    bytes: utf8ByteLength(line.text),
  }));
  return taskLogs(
    {
      id,
      state,
      nextCursor: from + lines.length - 1,
      earliestAvailableCursor: from - 1,
      droppedBytes,
      ...(discardedBefore && { discardedBefore }),
      retainedBytes: Arr.reduce(events, 0, (sum, event) => sum + event.bytes),
      events,
    },
    task,
  );
};
