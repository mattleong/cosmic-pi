import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  LocalProcess,
  type LocalProcessError,
  type LocalProcessHandle,
} from "../boundary/local-process.ts";
import { BackgroundTaskConfigStore } from "../config/store.ts";
import { normalizeStartRequest, validateWaitRequest } from "./admission.ts";
import {
  BackgroundTaskCapacityError,
  type BackgroundTaskNotFoundError,
  backgroundTaskNotFound,
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
  BackgroundTerminationError,
  type InvalidBackgroundCommandError,
  InvalidBackgroundCwdError,
  type BackgroundTaskError,
} from "./errors.ts";
import { readLogBuffer } from "./log-buffer.ts";
import {
  isActiveTaskState,
  sortTasksByActivity,
  type BackgroundTaskStatus,
  type BackgroundTaskStatusWait,
  type BackgroundLogSlice,
  type BackgroundLogStream,
  type BackgroundTaskProjection,
  type BackgroundTaskWaitResult,
  type ReadBackgroundLogs,
  type StartBackgroundTask,
  type WaitForBackgroundTask,
} from "./model.ts";
import { OutputMatcher } from "./output-match.ts";
import { startTaskPublication, monotonicMillis } from "./publication.ts";
import {
  activeRecords,
  clearFinished,
  completedSnapshot,
  enforceRetainedLogBudget,
  logFields,
  taskRecord,
  registryProjection,
  trimRetention,
  wakeTaskRecord,
  type TaskRecord,
  type TaskRegistry,
} from "./registry.ts";

export type BackgroundTaskFilter = "active" | "completed" | "all";

export interface BackgroundTaskServiceContract {
  readonly start: (
    request: StartBackgroundTask,
  ) => Effect.Effect<BackgroundTaskStatus, BackgroundTaskError>;
  readonly list: (
    filter?: BackgroundTaskFilter,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskStatus>>;
  readonly status: (id: string) => Effect.Effect<BackgroundTaskStatus, BackgroundTaskNotFoundError>;
  readonly logs: (
    request: ReadBackgroundLogs,
  ) => Effect.Effect<BackgroundLogSlice, BackgroundTaskNotFoundError>;
  readonly wait: (
    request: WaitForBackgroundTask,
  ) => Effect.Effect<
    BackgroundTaskStatusWait,
    BackgroundTaskNotFoundError | InvalidBackgroundCommandError
  >;
  readonly stop: (
    id: string,
    force?: boolean,
  ) => Effect.Effect<BackgroundTaskStatus, BackgroundTaskError>;
  readonly stopAll: (
    force?: boolean,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskStatus>, BackgroundTaskError>;
  readonly clear: Effect.Effect<number>;
}

export interface BackgroundTaskServiceOptions {
  readonly publish?: (projection: BackgroundTaskProjection) => void;
}

const runtimeClosed = () =>
  new BackgroundRuntimeClosedError({ message: "Background task runtime is closed." });

const makeService = Effect.fn("BackgroundTaskService.make")(function* (
  options: BackgroundTaskServiceOptions,
) {
  const config = yield* BackgroundTaskConfigStore;
  const processes = yield* LocalProcess;
  const path = yield* Path.Path;
  const ownerScope = yield* Effect.scope;
  const monitorScope = yield* Scope.fork(ownerScope);
  const lock = yield* Semaphore.make(1);
  const tasks: TaskRegistry = new Map();
  let nextId = 1;
  let admissionsClosed = false;
  const retainedLogBudget = Math.max(1, Math.floor(config.totalLogBufferBytes / 2));
  const ingressLogBudget = Math.max(1, config.totalLogBufferBytes - retainedLogBudget);
  const ingressBufferBytes = Math.max(
    1,
    Math.min(config.logBufferBytesPerTask, Math.floor(ingressLogBudget / config.maxRunning)),
  );

  const withLock = Semaphore.withPermit(lock);
  const { publish, publishOutput } = yield* startTaskPublication(lock, () =>
    options.publish?.(registryProjection(tasks)),
  );
  const settle = (record: TaskRecord, snapshot: BackgroundTaskStatus) => {
    record.snapshot = snapshot;
    wakeTaskRecord(record);
    Deferred.doneUnsafe(record.completion, Effect.succeed(snapshot));
    trimRetention(tasks, config.maxRetained);
    publish();
  };

  const appendOutput = (
    record: TaskRecord,
    stream: BackgroundLogStream,
    text: string,
    droppedBytes: number,
  ) =>
    withLock(
      Effect.gen(function* () {
        const timestamp = yield* Clock.currentTimeMillis;
        record.logs
          .addDropped(droppedBytes)
          .append(stream, text, timestamp, config.logBufferBytesPerTask, droppedBytes > 0);
        record.ingressDroppedObserved += droppedBytes;
        record.snapshot = { ...record.snapshot, ...logFields(record.logs) };
        wakeTaskRecord(record);
        enforceRetainedLogBudget(tasks, retainedLogBudget);
        yield* publishOutput;
      }),
    );

  const requestStop = Effect.fn("BackgroundTaskService.stop")(function* (
    id: string,
    force = false,
    outcome: "stopped" | "timed_out" = "stopped",
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          Effect.gen(function* () {
            const record = tasks.get(id);
            if (!record) return yield* backgroundTaskNotFound(id);
            if (!isActiveTaskState(record.snapshot.state))
              return { record, owner: false, terminal: record.snapshot };
            const owner = record.snapshot.state !== "stopping";
            record.terminalOutcome ??= outcome;
            record.snapshot = { ...record.snapshot, state: "stopping" };
            wakeTaskRecord(record);
            publish();
            return { record, owner, terminal: undefined };
          }),
        );
        if (prepared.terminal) return prepared.terminal;

        const terminate = (handle: LocalProcessHandle, mode: "graceful" | "force") =>
          handle
            .terminate(mode)
            .pipe(
              Effect.mapError(
                (error) => new BackgroundTerminationError({ id, message: error.message }),
              ),
            );
        const stopPhase = Effect.gen(function* () {
          const handle = Option.getOrUndefined(
            yield* Deferred.await(prepared.record.handleReady).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.catch(() => Effect.succeedNone),
            ),
          );
          if (!handle) return;
          if (force) yield* terminate(handle, "force");
          else if (prepared.owner) {
            yield* terminate(handle, "graceful");
            const settled = yield* Deferred.await(prepared.record.completion).pipe(
              Effect.timeoutOption(Duration.millis(config.stopGraceMs)),
            );
            if (Option.isNone(settled)) yield* terminate(handle, "force");
          }
        });
        yield* restore(stopPhase).pipe(
          Effect.onInterrupt(() =>
            prepared.owner
              ? Effect.gen(function* () {
                  const ready = yield* Deferred.poll(prepared.record.handleReady);
                  if (Option.isSome(ready))
                    yield* ready.value.pipe(Effect.flatMap((handle) => handle.terminate("force")));
                }).pipe(Effect.ignore)
              : Effect.void,
          ),
        );

        const finalWait = yield* restore(
          Deferred.await(prepared.record.completion).pipe(
            Effect.timeoutOption(Duration.millis(Math.max(5_000, config.stopGraceMs + 5_000))),
          ),
        );
        if (Option.isSome(finalWait)) return finalWait.value;
        return yield* new BackgroundTerminationError({
          id,
          message: "Background process did not confirm exit after forced termination.",
        });
      }),
    );
  });

  const monitor = (record: TaskRecord, request: StartBackgroundTask) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.spawn({
          command: request.command,
          cwd: request.cwd,
          ingressBufferBytes,
          ...(config.shellPath && { shellPath: config.shellPath }),
        });
        const stopRequested = yield* withLock(
          Effect.sync(() => {
            const stopping = record.snapshot.state === "stopping";
            record.snapshot = {
              ...record.snapshot,
              state: stopping ? "stopping" : "running",
              pid: handle.pid,
            };
            Deferred.doneUnsafe(record.handleReady, Effect.succeed(handle));
            wakeTaskRecord(record);
            publish();
            return stopping;
          }),
        );
        if (stopRequested) yield* handle.terminate("force").pipe(Effect.ignore);
        const outputFiber = yield* handle.output.pipe(
          Stream.runForEach((event) =>
            appendOutput(record, event.stream, event.text, event.droppedBytes),
          ),
          Effect.ignoreCause,
          Effect.forkScoped({ startImmediately: true }),
        );
        if (request.timeoutSeconds !== undefined) {
          yield* Effect.sleep(Duration.seconds(request.timeoutSeconds)).pipe(
            Effect.andThen(requestStop(record.snapshot.id, false, "timed_out")),
            Effect.ignore,
            Effect.forkScoped({ startImmediately: true }),
          );
        }
        const exit = yield* handle.awaitExit;
        const drained = yield* Fiber.await(outputFiber).pipe(Effect.timeoutOption("1 second"));
        if (Option.isNone(drained)) yield* Fiber.interrupt(outputFiber);
        const endedAt = yield* Clock.currentTimeMillis;
        yield* withLock(
          Effect.sync(() => {
            const unobservedDrops = Math.max(
              0,
              handle.droppedOutputBytes() - record.ingressDroppedObserved,
            );
            record.logs.addDropped(unobservedDrops);
            record.ingressDroppedObserved += unobservedDrops;
            settle(record, completedSnapshot(record, exit, endedAt));
          }),
        );
      }),
    ).pipe(
      Effect.catch((spawnError: LocalProcessError) =>
        withLock(
          Effect.gen(function* () {
            Deferred.doneUnsafe(record.handleReady, Effect.fail(spawnError));
            const endedAt = yield* Clock.currentTimeMillis;
            settle(record, {
              ...record.snapshot,
              state: "failed",
              endedAt,
              error: spawnError.message,
            });
          }),
        ),
      ),
      Effect.onInterrupt(() => Deferred.fail(record.handleReady, runtimeClosed())),
    );

  const start = Effect.fn("BackgroundTaskService.start")(function* (request: StartBackgroundTask) {
    const prepared = yield* normalizeStartRequest(request, path);
    const { command, cwd, name } = prepared;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const record = yield* withLock(
          Effect.gen(function* () {
            if (admissionsClosed || !config.enabled) {
              return yield* admissionsClosed
                ? runtimeClosed()
                : new BackgroundRuntimeClosedError({ message: "Background tasks are disabled." });
            }
            if (activeRecords(tasks).length >= config.maxRunning) {
              return yield* new BackgroundTaskCapacityError({
                limit: config.maxRunning,
                message: `Background task capacity reached (${config.maxRunning}).`,
              });
            }
            if (!Number.isSafeInteger(nextId)) {
              return yield* new BackgroundTaskCapacityError({
                limit: Number.MAX_SAFE_INTEGER,
                message: "Background task identity capacity reached.",
              });
            }
            const id = `task-${nextId}`;
            nextId += 1;
            const startedAt = yield* Clock.currentTimeMillis;
            const created = taskRecord({
              id,
              command,
              cwd,
              state: "starting",
              startedAt,
              logCursor: 0,
              droppedLogBytes: 0,
              ...(name && { name }),
            });
            tasks.set(id, created);
            publish();
            return created;
          }),
        );
        yield* monitor(record, prepared).pipe(
          Effect.forkIn(monitorScope, { startImmediately: true }),
        );
        return yield* restore(Deferred.await(record.handleReady)).pipe(
          Effect.andThen(Effect.sync(() => record.snapshot)),
          Effect.catchTag("LocalProcessError", (error) =>
            Effect.fail(
              error.reason === "cwd"
                ? new InvalidBackgroundCwdError({ cwd, message: error.message })
                : new BackgroundSpawnError({ message: error.message }),
            ),
          ),
        );
      }),
    );
  });

  const list: BackgroundTaskServiceContract["list"] = (filter = "all") =>
    withLock(
      Effect.sync(() =>
        sortTasksByActivity(
          [...tasks.values()].flatMap(({ snapshot }) =>
            filter === "all" || isActiveTaskState(snapshot.state) === (filter === "active")
              ? [snapshot]
              : [],
          ),
        ),
      ),
    );

  const status: BackgroundTaskServiceContract["status"] = (id) =>
    Effect.map(admitRecord(id), (record) => record.snapshot);

  const admitRecord = (id: string): Effect.Effect<TaskRecord, BackgroundTaskNotFoundError> =>
    withLock(
      Effect.suspend(() => {
        const record = tasks.get(id);
        return record ? Effect.succeed(record) : Effect.fail(backgroundTaskNotFound(id));
      }),
    );

  const pollUntil = <A>(
    deadline: number,
    inspect: () => { readonly value: A; readonly change: Effect.Effect<unknown> | undefined },
  ) =>
    Effect.gen(function* () {
      while (true) {
        const { value, change } = yield* withLock(Effect.sync(inspect));
        const remainingMillis = deadline - (yield* monotonicMillis);
        if (!change || remainingMillis <= 0) return value;
        yield* change.pipe(Effect.timeoutOption(Duration.millis(remainingMillis)));
      }
    });

  const logs = Effect.fn("BackgroundTaskService.logs")(function* (request: ReadBackgroundLogs) {
    const record = yield* admitRecord(request.id);
    const waitSeconds = request.waitSeconds ?? 0;
    const deadline =
      (yield* monotonicMillis) + Math.min(waitSeconds, config.maxWaitSeconds) * 1_000;
    return yield* pollUntil(deadline, () => {
      const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, request);
      const waits =
        waitSeconds > 0 && slice.events.length === 0 && isActiveTaskState(record.snapshot.state);
      return { value: slice, change: waits ? Deferred.await(record.wake) : undefined };
    });
  });

  const wait = Effect.fn("BackgroundTaskService.wait")(
    function* (request: WaitForBackgroundTask) {
      const waitSeconds = request.waitSeconds ?? config.maxWaitSeconds;
      yield* validateWaitRequest(request, waitSeconds);

      const record = yield* admitRecord(request.id);
      yield* Effect.acquireRelease(
        withLock(
          Effect.sync(() => {
            record.awaiters += 1;
            publish();
          }),
        ),
        () =>
          withLock(
            Effect.sync(() => {
              record.awaiters -= 1;
              publish();
            }),
          ),
      );
      const appliedWaitSeconds = Math.min(waitSeconds, config.maxWaitSeconds);
      const deadline = (yield* monotonicMillis) + appliedWaitSeconds * 1_000;
      const matcher = new OutputMatcher(
        request.until === "output" ? request.contains : undefined,
        request.afterCursor ?? 0,
      );

      return yield* pollUntil(deadline, () => {
        const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, {
          afterCursor: matcher.afterCursor,
        });
        const result = (
          outcome: BackgroundTaskWaitResult["outcome"],
          matchCursor?: number,
        ): BackgroundTaskStatusWait => ({
          id: record.snapshot.id,
          outcome,
          snapshot: record.snapshot,
          nextCursor: slice.nextCursor,
          earliestAvailableCursor: slice.earliestAvailableCursor,
          droppedBytes: slice.droppedBytes,
          ...(matchCursor !== undefined && { matchCursor }),
          appliedWaitSeconds,
        });
        const matchCursor = matcher.match(slice);
        if (matchCursor !== undefined)
          return { value: result("matched", matchCursor), change: undefined };
        if (!isActiveTaskState(record.snapshot.state))
          return { value: result("completed"), change: undefined };
        return {
          value: result("timeout"),
          change:
            request.until === "exit"
              ? Deferred.await(record.completion)
              : Deferred.await(record.wake),
        };
      });
    },
    (effect) => Effect.scoped(effect),
  );

  const stopAll = Effect.fn("BackgroundTaskService.stopAll")(function* (force = false) {
    const ids = yield* withLock(
      Effect.sync(() => activeRecords(tasks).map((record) => record.snapshot.id)),
    );
    const [settled, failures] = yield* Effect.partition(
      ids,
      (id) =>
        requestStop(id, force).pipe(
          Effect.catchTag("BackgroundTaskNotFoundError", () => Effect.undefined),
        ),
      { concurrency: 8 },
    );
    if (failures.length > 0) {
      return yield* new BackgroundTerminationError({
        id: failures.map((failure) => failure.id).join(", "),
        message: failures.map((failure) => `${failure.id}: ${failure.message}`).join(" · "),
      });
    }
    return settled.filter((snapshot) => snapshot !== undefined);
  });
  const clear = withLock(
    Effect.sync(() => {
      const removed = clearFinished(tasks);
      if (removed > 0) publish();
      return removed;
    }),
  );

  const service: BackgroundTaskServiceContract = {
    start,
    list,
    status,
    logs,
    wait,
    stop: requestStop,
    stopAll,
    clear,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        admissionsClosed = true;
      }),
    ).pipe(Effect.andThen(stopAll(false)), Effect.ignore),
  );

  return service;
});

export class BackgroundTaskService extends Context.Service<
  BackgroundTaskService,
  BackgroundTaskServiceContract
>()("pi-background-task/task/service/BackgroundTaskService") {
  static readonly layer = (options: BackgroundTaskServiceOptions = {}) =>
    Layer.effect(this, makeService(options));
}
