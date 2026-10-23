import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Rec from "effect/Record";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  clipText,
  invokeHostCallback,
  sanitizeDiagnosticError,
  utf8ByteLength,
} from "pi-cosmic-core";
import {
  LocalProcess,
  type LocalProcessError,
  type LocalProcessHandle,
} from "../boundary/local-process.ts";
import { BackgroundTaskConfigStore } from "../config/store.ts";
import { normalizeStartRequest, validateWaitRequest } from "./admission.ts";
import { BACKGROUND_LOG_BOUNDS, BACKGROUND_TASK_FIELD_BOUNDS } from "./bounds.ts";
import {
  afterCursorAhead,
  BackgroundTaskCapacityError,
  type BackgroundTaskNotFoundError,
  backgroundTaskNotFound,
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
  BackgroundTasksDisabledError,
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
  type BackgroundLogStream,
  type BackgroundTaskLogs,
  type BackgroundTaskProjection,
  type BackgroundTaskStopResult,
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
  ) => Effect.Effect<
    BackgroundTaskLogs,
    BackgroundTaskNotFoundError | InvalidBackgroundCommandError
  >;
  readonly wait: (
    request: WaitForBackgroundTask,
  ) => Effect.Effect<
    BackgroundTaskStatusWait,
    BackgroundTaskNotFoundError | InvalidBackgroundCommandError
  >;
  /** An explicit stop; repeating it while the task is stopping escalates to force. */
  readonly stop: (
    id: string,
    force?: boolean,
  ) => Effect.Effect<BackgroundTaskStopResult, BackgroundTaskError>;
  /**
   * Explicitly stops every active task, escalating those already stopping. Returns the tasks it
   * stopped, leaving out any that finished on their own before their stop landed.
   */
  readonly stopAll: (
    force?: boolean,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskStatus>, BackgroundTaskError>;
  readonly clear: Effect.Effect<number>;
}

export interface BackgroundTaskServiceOptions {
  readonly publish?: (projection: BackgroundTaskProjection) => void;
}

const SHUTDOWN_WARNING_CHARS = 500;

const leaderExited = (record: TaskRecord) =>
  Deferred.poll(record.handleReady).pipe(
    Effect.flatMap((ready) =>
      Option.isSome(ready)
        ? ready.value.pipe(
            Effect.flatMap((handle) => handle.leaderExited),
            Effect.orElseSucceed(() => false),
          )
        : Effect.succeed(false),
    ),
  );

const runtimeClosed = () =>
  BackgroundRuntimeClosedError.make({ message: "Background task runtime is closed." });

/** Explicit stops escalate a stopping task to force; internal stops join its grace window. */
type StopRequest = "explicit" | "internal";

const checkCursor = (record: TaskRecord, afterCursor: number | undefined) =>
  Effect.suspend(() => {
    const latest = record.logs.latestCursor;
    return afterCursor === undefined || afterCursor <= latest
      ? Effect.void
      : Effect.fail(afterCursorAhead(record.snapshot.id, afterCursor, latest));
  });

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
  // Output still in flight has its own per-task bound, outside the retained budgets.
  const ingressBufferBytes = Math.max(
    BACKGROUND_LOG_BOUNDS.minIngressBytes,
    Math.min(config.logBufferBytesPerTask, BACKGROUND_LOG_BOUNDS.maxIngressBytes),
  );

  // Every holder's critical section is synchronous apart from reading the clock: no holder
  // awaits another fiber, a process, or the host. Stop claims, start admission, and wait
  // registration wait for this lock with interruption masked, so that a claim and its handoff
  // can't be split; those waits stay brief only because every holder releases promptly.
  const withLock = Semaphore.withPermit(lock);
  // A failing host publisher must not abort the registry transition that is publishing.
  const { publish, publishOutput } = yield* startTaskPublication(lock, () =>
    invokeHostCallback(() => options.publish?.(registryProjection(tasks)), undefined),
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
    Effect.suspend(() => {
      let appended = false;
      return withLock(
        Effect.gen(function* () {
          const timestamp = yield* Clock.currentTimeMillis;
          // Lost output may have cut a sequence short; what follows starts fresh.
          if (droppedBytes > 0)
            for (const terminal of Rec.values(record.terminal)) terminal.reset();
          record.logs
            .addDropped(droppedBytes)
            .append(
              stream,
              record.terminal[stream].write(text),
              timestamp,
              config.logBufferBytesPerTask,
            );
          record.ingressDroppedObserved += droppedBytes;
          record.snapshot = { ...record.snapshot, ...logFields(record.logs) };
          appended = true;
          wakeTaskRecord(record);
          enforceRetainedLogBudget(tasks, config.totalLogBufferBytes);
          yield* publishOutput;
        }),
      ).pipe(
        // The boundary already counts the event as delivered, so text an interrupted reader
        // received but never stored, as an abandoned reader's may be, is counted as dropped here.
        Effect.onInterrupt(() =>
          appended
            ? Effect.void
            : withLock(
                Effect.sync(() => {
                  record.logs.addDropped(utf8ByteLength(text));
                  record.snapshot = { ...record.snapshot, ...logFields(record.logs) };
                }),
              ),
        ),
      );
    });

  const requestStop = Effect.fn("BackgroundTaskService.stop")(function* (
    id: string,
    force: boolean,
    request: StopRequest,
    outcome: "stopped" | "timed_out" = "stopped",
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          Effect.gen(function* () {
            const record = tasks.get(id);
            if (!record) return yield* backgroundTaskNotFound(id);
            if (!isActiveTaskState(record.snapshot.state))
              return { record, owner: false, joins: false, terminal: record.snapshot };
            const owner = record.snapshot.state !== "stopping";
            const joins = !owner && !force && request === "internal" && record.graceWindowOpen;
            if (owner && !force) record.graceWindowOpen = true;
            // A request that lands after the command exited on its own keeps that exit's outcome.
            if (!(yield* leaderExited(record))) record.terminalOutcome ??= outcome;
            record.snapshot = { ...record.snapshot, state: "stopping" };
            wakeTaskRecord(record);
            publish();
            return { record, owner, joins, terminal: undefined };
          }),
        );
        if (prepared.terminal)
          return {
            snapshot: prepared.terminal,
            alreadyFinished: true,
          } satisfies BackgroundTaskStopResult;

        let forced = false;
        const terminate = (handle: LocalProcessHandle, mode: "graceful" | "force") =>
          Effect.suspend(() => {
            if (mode === "force") forced = true;
            return handle.terminate(mode);
          }).pipe(
            Effect.mapError((error) =>
              BackgroundTerminationError.make({ id, message: error.message }),
            ),
          );
        const stopPhase = Effect.gen(function* () {
          const handle = Option.getOrUndefined(
            yield* Deferred.await(prepared.record.handleReady).pipe(
              Effect.timeoutOption("5 seconds"),
              Effect.catch(() => Effect.succeedNone),
            ),
          );
          if (!handle || prepared.joins) return;
          // The first stop owns the grace window. A repeated explicit stop escalates instead of
          // waiting, as does an internal stop once no grace window remains.
          if (force || !prepared.owner) yield* terminate(handle, "force");
          else {
            yield* terminate(handle, "graceful");
            const settled = yield* Deferred.await(prepared.record.completion).pipe(
              Effect.timeoutOption(Duration.millis(config.stopGraceMs)),
            );
            if (Option.isNone(settled)) yield* terminate(handle, "force");
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (prepared.owner) prepared.record.graceWindowOpen = false;
            }),
          ),
        );
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
        if (Option.isSome(finalWait))
          return {
            snapshot: finalWait.value,
            alreadyFinished: false,
          } satisfies BackgroundTaskStopResult;
        return yield* BackgroundTerminationError.make({
          id,
          message: forced
            ? "Background process did not confirm exit after forced termination."
            : prepared.joins
              ? "Background process did not confirm exit after its stop grace period."
              : "Background process did not confirm exit; it had not finished starting.",
        });
      }),
    );
  });

  const monitor = Effect.fn("BackgroundTaskService.monitor")(
    function* (record: TaskRecord, request: StartBackgroundTask) {
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
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Background task output stopped recording after a reader failure."),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      if (request.timeoutSeconds !== undefined) {
        yield* Effect.sleep(Duration.seconds(request.timeoutSeconds)).pipe(
          Effect.andThen(requestStop(record.snapshot.id, false, "internal", "timed_out")),
          Effect.ignore,
          Effect.forkScoped({ startImmediately: true }),
        );
      }
      const exit = yield* handle.awaitExit;
      const drained = yield* Fiber.await(outputFiber).pipe(Effect.timeoutOption("1 second"));
      if (Option.isNone(drained)) {
        // A process outside the task's group can hold its pipes open. Output the reader hasn't
        // received, including the rest of a batch it already pulled, is counted as dropped and
        // skipped, so the reader only finishes an append already in progress; one still
        // unfinished when the reader is interrupted counts its text as dropped.
        yield* handle.abandonOutput;
        const finished = yield* Fiber.await(outputFiber).pipe(Effect.timeoutOption("1 second"));
        if (Option.isNone(finished)) yield* Fiber.interrupt(outputFiber);
      }
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
    },
    Effect.scoped,
    (effect, record) =>
      effect.pipe(
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
      ),
  );

  const start = Effect.fn("BackgroundTaskService.start")(function* (request: StartBackgroundTask) {
    const prepared = yield* normalizeStartRequest(request, path);
    const { command, cwd, name } = prepared;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const record = yield* withLock(
          Effect.gen(function* () {
            if (admissionsClosed) return yield* runtimeClosed();
            if (!config.enabled) {
              return yield* BackgroundTasksDisabledError.make({
                message: "Background tasks are disabled.",
              });
            }
            if (activeRecords(tasks).length >= config.maxRunning) {
              return yield* BackgroundTaskCapacityError.make({
                limit: config.maxRunning,
                message: `Background task capacity reached (${config.maxRunning}).`,
              });
            }
            if (!Number.isSafeInteger(nextId)) {
              return yield* BackgroundTaskCapacityError.make({
                limit: Number.MAX_SAFE_INTEGER,
                message: "Background task identity capacity reached.",
              });
            }
            const id = `task-${nextId}`;
            nextId += 1;
            const startedAt = yield* Clock.currentTimeMillis;
            // The record keeps a display copy; the monitor runs the full prepared command.
            const created = taskRecord({
              id,
              command: clipText(command, BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars),
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
                ? InvalidBackgroundCwdError.make({ cwd, message: error.message })
                : BackgroundSpawnError.make({ message: error.message }),
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
          Arr.flatMap([...tasks.values()], ({ snapshot }) =>
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

  const pollUntil = Effect.fn("BackgroundTaskService.pollUntil")(function* <A>(
    deadline: number,
    inspect: () => { readonly value: A; readonly change: Effect.Effect<unknown> | undefined },
  ) {
    while (true) {
      const { value, change } = yield* withLock(Effect.sync(inspect));
      const remainingMillis = deadline - (yield* monotonicMillis);
      if (!change || remainingMillis <= 0) return value;
      yield* change.pipe(Effect.timeoutOption(Duration.millis(remainingMillis)));
    }
  });

  const logs = Effect.fn("BackgroundTaskService.logs")(function* (request: ReadBackgroundLogs) {
    const record = yield* admitRecord(request.id);
    yield* withLock(checkCursor(record, request.afterCursor));
    const waitSeconds = request.waitSeconds ?? 0;
    const deadline =
      (yield* monotonicMillis) + Math.min(waitSeconds, config.maxWaitSeconds) * 1_000;
    const window =
      request.tailLines === undefined
        ? request
        : {
            ...request,
            tailLines: Math.min(request.tailLines, BACKGROUND_TASK_FIELD_BOUNDS.maxTailLines),
          };
    return yield* pollUntil(deadline, () => {
      const { snapshot } = record;
      const slice = readLogBuffer(request.id, record.logs, snapshot.state, window);
      const waits =
        waitSeconds > 0 && slice.events.length === 0 && isActiveTaskState(snapshot.state);
      const task = Object.freeze({
        ...(snapshot.name !== undefined && { name: snapshot.name }),
        command: snapshot.command,
      });
      return {
        value: Object.freeze({ ...slice, task }) satisfies BackgroundTaskLogs,
        change: waits ? Deferred.await(record.wake) : undefined,
      };
    });
  });

  const wait = Effect.fn("BackgroundTaskService.wait")(
    function* (request: WaitForBackgroundTask) {
      const waitSeconds = request.waitSeconds ?? config.maxWaitSeconds;
      yield* validateWaitRequest(request, waitSeconds);

      const record = yield* admitRecord(request.id);
      yield* withLock(checkCursor(record, request.afterCursor));
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

  const stopAll = Effect.fn("BackgroundTaskService.stopAll")(function* (
    force: boolean,
    request: StopRequest,
  ) {
    const ids = yield* withLock(
      Effect.sync(() => Arr.map(activeRecords(tasks), (record) => record.snapshot.id)),
    );
    // Every task gets its graceful signal at once, so the batch shares one grace window.
    const [settled, failures] = yield* Effect.partition(
      ids,
      (id) =>
        requestStop(id, force, request).pipe(
          Effect.catchTag("BackgroundTaskNotFoundError", () => Effect.undefined),
        ),
      { concurrency: "unbounded" },
    );
    if (failures.length > 0) {
      return yield* BackgroundTerminationError.make({
        id: Arr.join(
          Arr.map(failures, (failure) => failure.id),
          ", ",
        ),
        message: Arr.join(
          Arr.map(failures, (failure) => `${failure.id}: ${failure.message}`),
          " · ",
        ),
      });
    }
    return Arr.flatMap(settled, (result) =>
      result && !result.alreadyFinished ? [result.snapshot] : [],
    );
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
    stop: (id, force = false) => requestStop(id, force, "explicit"),
    stopAll: (force = false) => stopAll(force, "explicit"),
    clear,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        admissionsClosed = true;
      }),
    ).pipe(
      // Shutdown and tree navigation join stops already in their grace window.
      Effect.andThen(stopAll(false, "internal")),
      Effect.catch((error) =>
        Effect.logWarning(
          `Background task shutdown couldn't confirm every process exited: ${sanitizeDiagnosticError(
            error.message,
            { maximumLength: SHUTDOWN_WARNING_CHARS },
          )}`,
        ),
      ),
    ),
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
