import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  LocalProcess,
  type LocalProcessError,
  type LocalProcessExit,
  type LocalProcessHandle,
} from "../boundary/local-process.ts";
import { outputFailureLine } from "pi-code-previews";
import { BackgroundTaskConfigStore } from "../config/store.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "./bounds.ts";
import {
  BackgroundTaskCapacityError,
  BackgroundTaskNotFoundError,
  backgroundTaskNotFound,
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
  BackgroundTerminationError,
  InvalidBackgroundCommandError,
  InvalidBackgroundCwdError,
  type BackgroundTaskError,
} from "./errors.ts";
import { LogBuffer, readLogBuffer } from "./log-buffer.ts";
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

/** The task's latest retained output, as lines. */
const recentOutputLines = (record: TaskRecord): string[] =>
  readLogBuffer(record.snapshot.id, record.logs, record.snapshot.state, { tailLines: 200 })
    .events.map((event) => event.text)
    .join("")
    .split(/\r?\n/u);

interface TaskRecord {
  snapshot: BackgroundTaskStatus;
  readonly logs: LogBuffer;
  wake: Deferred.Deferred<void>;
  readonly completion: Deferred.Deferred<BackgroundTaskStatus>;
  readonly handleReady: Deferred.Deferred<
    LocalProcessHandle,
    LocalProcessError | BackgroundRuntimeClosedError
  >;
  terminalOutcome?: "stopped" | "timed_out";
  ingressDroppedObserved: number;
  awaiters: number;
}

/** Snapshot log metadata as the record's buffer currently reports it. */
const logFields = (logs: LogBuffer) => ({
  logCursor: logs.nextCursor - 1,
  droppedLogBytes: logs.droppedBytes,
});

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

const invalidCommand = (message: string) => new InvalidBackgroundCommandError({ message });
const runtimeClosed = () =>
  new BackgroundRuntimeClosedError({ message: "Background task runtime is closed." });

/** Output chunks coalesce into at most one projection publish per interval. */
const OUTPUT_PUBLISH_INTERVAL_MILLIS = 1_000;

/** Deadlines use elapsed time, which wall-clock steps cannot move; timestamps stay wall-clock. */
const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1_000_000n));

const makeService = Effect.fn("BackgroundTaskService.make")(function* (
  options: BackgroundTaskServiceOptions,
) {
  const config = yield* BackgroundTaskConfigStore;
  const processes = yield* LocalProcess;
  const path = yield* Path.Path;
  const ownerScope = yield* Effect.scope;
  // The parent owns one fixed monitor scope. The service shutdown finalizer is registered later,
  // so it requests and confirms process settlement before the monitor scope is interrupted.
  const monitorScope = yield* Scope.fork(ownerScope);
  const lock = yield* Semaphore.make(1);
  const tasks = new Map<string, TaskRecord>();
  let nextId = 1;
  // Set by the shutdown finalizer under the same lock that guards admission.
  let admissionsClosed = false;
  const retainedLogBudget = Math.max(1, Math.floor(config.totalLogBufferBytes / 2));
  const ingressLogBudget = Math.max(1, config.totalLogBufferBytes - retainedLogBudget);
  const ingressBufferBytes = Math.max(
    1,
    Math.min(config.logBufferBytesPerTask, Math.floor(ingressLogBudget / config.maxRunning)),
  );

  const withLock = Semaphore.withPermit(lock);
  const wake = (record: TaskRecord) => {
    const current = record.wake;
    record.wake = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(current, Effect.void);
  };
  // Rows detach scalar task state while sharing the buffer's immutable events.
  const currentProjection = (): BackgroundTaskProjection =>
    Object.freeze({
      tasks: Object.freeze(
        sortTasksByActivity(
          [...tasks.values()].map((record) =>
            Object.freeze({
              ...record.snapshot,
              logs: record.logs.events,
              awaited: record.awaiters > 0,
            }),
          ),
        ),
      ),
    });
  let outputPublishPending = false;
  let outputPublishDeadline = 0;
  const outputPublishWake = yield* Latch.make();
  const publish = () => {
    outputPublishPending = false;
    options.publish?.(currentProjection());
  };
  yield* Effect.gen(function* () {
    yield* Latch.await(outputPublishWake);
    const delayMillis = yield* withLock(
      Effect.map(monotonicMillis, (now) => Math.max(0, outputPublishDeadline - now)),
    );
    yield* Effect.sleep(Duration.millis(delayMillis));
    yield* withLock(
      Effect.gen(function* () {
        Latch.closeUnsafe(outputPublishWake);
        if (!outputPublishPending) return;
        outputPublishDeadline = (yield* monotonicMillis) + OUTPUT_PUBLISH_INTERVAL_MILLIS;
        publish();
      }),
    );
  }).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }));
  const totalLogBytes = () =>
    [...tasks.values()].reduce((total, record) => total + record.logs.bytes, 0);
  const enforceTotalLogBudget = () => {
    let total = totalLogBytes();
    while (total > retainedLogBudget) {
      let selected: TaskRecord | undefined;
      for (const record of tasks.values()) {
        const first = record.logs.oldestEvent;
        const selectedFirst = selected?.logs.oldestEvent;
        if (first && (!selectedFirst || first.timestamp < selectedFirst.timestamp))
          selected = record;
      }
      const dropped = selected?.logs.oldestEvent;
      if (!selected || !dropped) break;
      selected.logs.dropOldest();
      total -= dropped.bytes;
      selected.snapshot = { ...selected.snapshot, ...logFields(selected.logs) };
      wake(selected);
    }
  };
  const trimRetention = () => {
    const completed = [...tasks.values()]
      .filter((record) => !isActiveTaskState(record.snapshot.state))
      .sort((left, right) => (left.snapshot.endedAt ?? 0) - (right.snapshot.endedAt ?? 0));
    const evicted = completed.slice(0, Math.max(0, completed.length - config.maxRetained));
    for (const record of evicted) tasks.delete(record.snapshot.id);
  };
  /** The terminal transition: readers wake, completion settles, retention trims, rows publish. */
  const settle = (record: TaskRecord, snapshot: BackgroundTaskStatus) => {
    record.snapshot = snapshot;
    wake(record);
    Deferred.doneUnsafe(record.completion, Effect.succeed(snapshot));
    trimRetention();
    publish();
  };
  const completeRecord = (record: TaskRecord, exit: LocalProcessExit, endedAt: number) => {
    const state = record.terminalOutcome ?? (exit.exitCode !== 0 ? "failed" : "exited");
    // The output that says why is only here now; keep one redacted, bounded line of it in memory.
    const failureCause =
      state === "failed" ? outputFailureLine(recentOutputLines(record)) : undefined;
    settle(record, {
      ...record.snapshot,
      state,
      endedAt,
      exitCode: exit.exitCode,
      ...(exit.signal && { signal: exit.signal }),
      ...(failureCause && { failureCause }),
      ...logFields(record.logs),
    });
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
        wake(record);
        enforceTotalLogBudget();
        // Output-driven publishes coalesce onto an interval; a trailing flush
        // covers chunks that land between the leading edge and quiescence.
        outputPublishPending = true;
        const now = yield* monotonicMillis;
        if (now >= outputPublishDeadline) {
          outputPublishDeadline = now + OUTPUT_PUBLISH_INTERVAL_MILLIS;
          publish();
        } else {
          Latch.openUnsafe(outputPublishWake);
        }
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
            wake(record);
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
              // A spawn that failed or never started has no handle to stop.
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
        // Keep this hook outside the timeout operators so their internal interruption cannot force twice.
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

  // Only a record's monitor ends it, and only ended records leave `tasks`, so the record a
  // monitor owns stays registered and active until the monitor settles it.
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
            // Waiters resume synchronously, so start must already see the running snapshot.
            Deferred.doneUnsafe(record.handleReady, Effect.succeed(handle));
            wake(record);
            publish();
            return stopping;
          }),
        );
        // A stop claimed before the handle existed could not reach this process.
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
            completeRecord(record, exit, endedAt);
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
      // Closing the runtime can interrupt a spawn that never settled; its start must not hang.
      Effect.onInterrupt(() => Deferred.fail(record.handleReady, runtimeClosed())),
    );

  const start = Effect.fn("BackgroundTaskService.start")(function* (request: StartBackgroundTask) {
    const command = request.command.trim();
    if (!command) return yield* invalidCommand("Background command must not be empty.");
    if (command.length > BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars)
      return yield* invalidCommand(
        `Background command must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars} characters.`,
      );
    const name = request.name?.trim();
    if ((name?.length ?? 0) > BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars)
      return yield* invalidCommand(
        `Background task name must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars} characters.`,
      );
    if (
      request.timeoutSeconds !== undefined &&
      (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0)
    )
      return yield* invalidCommand(
        "Background timeout must be a positive finite number of seconds.",
      );
    const cwd = path.resolve(request.cwd);
    if (cwd.length > BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars) {
      return yield* new InvalidBackgroundCwdError({
        cwd,
        message: `Resolved background working directory must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxCwdChars} characters.`,
      });
    }
    const prepared: StartBackgroundTask = {
      command,
      cwd,
      ...(name && { name }),
      ...(request.timeoutSeconds !== undefined && { timeoutSeconds: request.timeoutSeconds }),
    };
    // Admission, the monitor fork, and the handoff to the caller's wait form one masked claim.
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const record = yield* withLock(
          Effect.gen(function* () {
            if (admissionsClosed || !config.enabled) {
              return yield* admissionsClosed
                ? runtimeClosed()
                : new BackgroundRuntimeClosedError({ message: "Background tasks are disabled." });
            }
            const active = [...tasks.values()].filter((item) =>
              isActiveTaskState(item.snapshot.state),
            ).length;
            if (active >= config.maxRunning) {
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
            const created: TaskRecord = {
              snapshot: {
                id,
                command,
                cwd,
                state: "starting",
                startedAt,
                logCursor: 0,
                droppedLogBytes: 0,
                ...(name && { name }),
              },
              logs: new LogBuffer(),
              wake: Deferred.makeUnsafe<void>(),
              completion: Deferred.makeUnsafe<BackgroundTaskStatus>(),
              handleReady: Deferred.makeUnsafe(),
              ingressDroppedObserved: 0,
              awaiters: 0,
            };
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
          Effect.mapError((error) =>
            error._tag === "BackgroundRuntimeClosedError"
              ? error
              : error.reason === "cwd"
                ? new InvalidBackgroundCwdError({ cwd, message: error.message })
                : new BackgroundSpawnError({ message: error.message }),
          ),
        );
      }),
    );
  });

  const list: BackgroundTaskServiceContract["list"] = (filter = "all") =>
    withLock(
      Effect.sync(() =>
        sortTasksByActivity(
          [...tasks.values()]
            .map((record) => record.snapshot)
            .filter(
              (snapshot) =>
                filter === "all" || isActiveTaskState(snapshot.state) === (filter === "active"),
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

  /**
   * Re-inspects an admitted record under the lock until an inspection names no further change
   * to await or the deadline passes, then returns that inspection's value.
   */
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
    // Other wakes (trimmed history, stop requests) leave nothing new to return; keep waiting.
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
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0)
        return yield* invalidCommand(
          "Background task wait must be a non-negative finite number of seconds.",
        );
      if (
        request.afterCursor !== undefined &&
        (!Number.isInteger(request.afterCursor) || request.afterCursor < 0)
      )
        return yield* invalidCommand("Background task wait cursor must be a non-negative integer.");
      const contains = request.contains;
      if (request.until === "exit" && (contains !== undefined || request.afterCursor !== undefined))
        return yield* invalidCommand(
          "contains and afterCursor are valid only when waiting for output.",
        );
      if (
        request.until === "output" &&
        (!contains ||
          contains.length > BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars ||
          contains.includes("\0"))
      )
        return yield* invalidCommand(
          `Output waits require a non-empty contains value of at most ${BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars} characters with no NUL byte.`,
        );

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
      let scanAfterCursor = request.afterCursor ?? 0;
      const carryByStream = { stdout: "", stderr: "" } satisfies Record<
        BackgroundLogStream,
        string
      >;

      return yield* pollUntil(deadline, () => {
        const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, {
          afterCursor: scanAfterCursor,
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
        if (request.until === "output" && contains) {
          if (slice.earliestAvailableCursor > scanAfterCursor + 1) {
            carryByStream.stdout = "";
            carryByStream.stderr = "";
          }
          let matchCursor: number | undefined;
          for (const event of slice.events) {
            if (event.droppedBefore) {
              carryByStream.stdout = "";
              carryByStream.stderr = "";
            }
            const candidate = carryByStream[event.stream] + event.text;
            if (candidate.includes(contains)) {
              matchCursor = event.cursor;
              break;
            }
            carryByStream[event.stream] =
              contains.length > 1 ? candidate.slice(-(contains.length - 1)) : "";
          }
          scanAfterCursor = Math.max(scanAfterCursor, slice.nextCursor);
          if (matchCursor !== undefined)
            return { value: result("matched", matchCursor), change: undefined };
        }
        if (!isActiveTaskState(record.snapshot.state))
          return { value: result("completed"), change: undefined };
        // A timeout reports this last inspection unless a change brings a result first.
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
      Effect.sync(() =>
        [...tasks.values()]
          .filter((record) => isActiveTaskState(record.snapshot.state))
          .map((record) => record.snapshot.id),
      ),
    );
    // Partition isolates typed failures; interruption and defects still interrupt the batch.
    const [settled, failures] = yield* Effect.partition(
      ids,
      (id) =>
        requestStop(id, force).pipe(
          // A task can settle and be evicted between capture and stop; that race is success.
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
      let removed = 0;
      for (const [id, record] of tasks) {
        if (isActiveTaskState(record.snapshot.state)) continue;
        tasks.delete(id);
        removed += 1;
      }
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
