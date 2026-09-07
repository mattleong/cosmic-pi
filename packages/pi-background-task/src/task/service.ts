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
import { BackgroundTaskConfigStore } from "../config/store.ts";
import { BACKGROUND_TASK_FIELD_BOUNDS } from "./bounds.ts";
import {
  BackgroundTaskCapacityError,
  BackgroundTaskNotFoundError,
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
  type BackgroundTaskSnapshot,
  type BackgroundTaskState,
  type BackgroundLogSlice,
  type BackgroundLogStream,
  type BackgroundTaskProjection,
  type BackgroundTaskWaitResult,
  type ReadBackgroundLogs,
  type StartBackgroundTask,
  type WaitForBackgroundTask,
} from "./model.ts";

interface TaskRecord {
  snapshot: BackgroundTaskSnapshot;
  readonly logs: LogBuffer;
  wake: Deferred.Deferred<void>;
  completion: Deferred.Deferred<BackgroundTaskSnapshot>;
  handleReady: Deferred.Deferred<LocalProcessHandle, LocalProcessError>;
  terminalOutcome?: "stopped" | "timed_out";
  ingressDroppedObserved: number;
  awaiters: number;
}

type WaitInspection =
  | { readonly _tag: "result"; readonly result: BackgroundTaskWaitResult }
  | {
      readonly _tag: "pending";
      readonly awaitChange: Effect.Effect<void>;
      readonly snapshot: BackgroundTaskSnapshot;
      readonly slice: BackgroundLogSlice;
    };

export type BackgroundTaskFilter = "active" | "completed" | "all";

export interface BackgroundTaskServiceContract {
  readonly start: (
    request: StartBackgroundTask,
  ) => Effect.Effect<BackgroundTaskSnapshot, BackgroundTaskError>;
  readonly list: (
    filter?: BackgroundTaskFilter,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskSnapshot>>;
  readonly status: (
    id: string,
  ) => Effect.Effect<BackgroundTaskSnapshot, BackgroundTaskNotFoundError>;
  readonly logs: (
    request: ReadBackgroundLogs,
  ) => Effect.Effect<BackgroundLogSlice, BackgroundTaskNotFoundError>;
  readonly wait: (
    request: WaitForBackgroundTask,
  ) => Effect.Effect<
    BackgroundTaskWaitResult,
    BackgroundTaskNotFoundError | InvalidBackgroundCommandError
  >;
  readonly stop: (
    id: string,
    force?: boolean,
  ) => Effect.Effect<BackgroundTaskSnapshot, BackgroundTaskError>;
  readonly stopAll: (
    force?: boolean,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskSnapshot>, BackgroundTaskError>;
  readonly clear: Effect.Effect<number>;
}

export interface BackgroundTaskServiceOptions {
  readonly publish?: (projection: BackgroundTaskProjection) => void;
}

const notFound = (id: string) =>
  new BackgroundTaskNotFoundError({ id, message: `Background task not found: ${id}` });

const waitResult = (
  snapshot: BackgroundTaskSnapshot,
  slice: BackgroundLogSlice,
  outcome: BackgroundTaskWaitResult["outcome"],
  matchCursor?: number,
): BackgroundTaskWaitResult => ({
  id: snapshot.id,
  outcome,
  snapshot,
  nextCursor: slice.nextCursor,
  earliestAvailableCursor: slice.earliestAvailableCursor,
  droppedBytes: slice.droppedBytes,
  ...(matchCursor !== undefined && { matchCursor }),
});

/** Output chunks coalesce into at most one projection publish per interval. */
const OUTPUT_PUBLISH_INTERVAL_MILLIS = 1_000;

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

  const withLock = Semaphore.withPermit(lock);
  const wake = (record: TaskRecord) => {
    const current = record.wake;
    record.wake = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(current, Effect.void);
  };
  const currentProjection = (): BackgroundTaskProjection => ({
    tasks: sortTasksByActivity(
      [...tasks.values()].map((record) => ({
        ...record.snapshot,
        logs: record.logs.events,
        awaited: record.awaiters > 0,
      })),
    ),
  });
  let outputPublishPending = false;
  let outputPublishDeadline = 0;
  const outputPublishWake = yield* Latch.make();
  const publish = () => {
    outputPublishPending = false;
    options.publish?.(currentProjection());
  };
  const outputPublishWorker = Effect.forever(
    Latch.await(outputPublishWake).pipe(
      Effect.flatMap(() =>
        withLock(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            return Math.max(0, outputPublishDeadline - now);
          }),
        ),
      ),
      Effect.flatMap((delayMillis) => Effect.sleep(Duration.millis(delayMillis))),
      Effect.andThen(
        withLock(
          Effect.gen(function* () {
            Latch.closeUnsafe(outputPublishWake);
            if (!outputPublishPending) return;
            outputPublishDeadline =
              (yield* Clock.currentTimeMillis) + OUTPUT_PUBLISH_INTERVAL_MILLIS;
            publish();
          }),
        ),
      ),
    ),
  );
  yield* Effect.forkIn(outputPublishWorker, ownerScope, { startImmediately: true });
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
      selected.snapshot = {
        ...selected.snapshot,
        droppedLogBytes: selected.logs.droppedBytes,
      };
      wake(selected);
    }
  };
  const trimRetention = () => {
    const completed = [...tasks.values()]
      .filter((record) => !isActiveTaskState(record.snapshot.state))
      .sort((left, right) => (left.snapshot.endedAt ?? 0) - (right.snapshot.endedAt ?? 0));
    const evictionCount = completed.length - config.maxRetained;
    if (evictionCount <= 0) return;
    for (const evicted of completed.slice(0, evictionCount)) tasks.delete(evicted.snapshot.id);
  };
  const completeRecord = (record: TaskRecord, exit: LocalProcessExit, endedAt: number) => {
    if (!isActiveTaskState(record.snapshot.state)) return;
    const state: BackgroundTaskState = record.terminalOutcome
      ? record.terminalOutcome
      : exit.exitCode !== 0
        ? "failed"
        : "exited";
    record.snapshot = {
      ...record.snapshot,
      state,
      endedAt,
      exitCode: exit.exitCode,
      ...(exit.signal && { signal: exit.signal }),
      logCursor: record.logs.nextCursor - 1,
      droppedLogBytes: record.logs.droppedBytes,
    };
    wake(record);
    Deferred.doneUnsafe(record.completion, Effect.succeed(record.snapshot));
    trimRetention();
    publish();
  };

  const appendOutput = (
    id: string,
    stream: "stdout" | "stderr",
    text: string,
    droppedBytes: number,
  ) =>
    withLock(
      Effect.gen(function* () {
        const record = tasks.get(id);
        if (!record || !isActiveTaskState(record.snapshot.state)) return;
        const timestamp = yield* Clock.currentTimeMillis;
        record.logs
          .addDropped(droppedBytes)
          .append(stream, text, timestamp, config.logBufferBytesPerTask, droppedBytes > 0);
        record.ingressDroppedObserved += droppedBytes;
        record.snapshot = {
          ...record.snapshot,
          logCursor: record.logs.nextCursor - 1,
          droppedLogBytes: record.logs.droppedBytes,
        };
        wake(record);
        enforceTotalLogBudget();
        // Output-driven publishes coalesce onto an interval; a trailing flush
        // covers chunks that land between the leading edge and quiescence.
        outputPublishPending = true;
        if (timestamp >= outputPublishDeadline) {
          outputPublishDeadline = timestamp + OUTPUT_PUBLISH_INTERVAL_MILLIS;
          publish();
        } else {
          Latch.openUnsafe(outputPublishWake);
        }
      }),
    );

  type StopPreparation = {
    readonly record: TaskRecord;
    readonly owner: boolean;
    readonly terminal?: BackgroundTaskSnapshot;
  };

  const requestStop = (
    id: string,
    force = false,
    outcome: "stopped" | "timed_out" = "stopped",
  ): Effect.Effect<
    BackgroundTaskSnapshot,
    BackgroundTaskNotFoundError | BackgroundTerminationError
  > =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          Effect.suspend((): Effect.Effect<StopPreparation, BackgroundTaskNotFoundError> => {
            const record = tasks.get(id);
            if (!record) return Effect.fail(notFound(id));
            if (!isActiveTaskState(record.snapshot.state)) {
              return Effect.succeed({
                record,
                owner: false,
                terminal: record.snapshot,
              } satisfies StopPreparation);
            }
            const owner = record.snapshot.state !== "stopping";
            record.terminalOutcome ??= outcome;
            record.snapshot = { ...record.snapshot, state: "stopping" };
            wake(record);
            publish();
            return Effect.succeed({ record, owner } satisfies StopPreparation);
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
              // A spawn failure already settles the handle deferred's consumer elsewhere;
              // a failed wait still reads as "no handle" exactly as the previous idiom did.
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

  const monitor = (id: string, ownerRecord: TaskRecord, request: StartBackgroundTask) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.spawn({
          command: request.command,
          cwd: request.cwd,
          ingressBufferBytes: Math.max(
            1,
            Math.min(
              config.logBufferBytesPerTask,
              Math.floor(ingressLogBudget / config.maxRunning),
            ),
          ),
          ...(config.shellPath && { shellPath: config.shellPath }),
        });
        const terminateLateHandle = yield* withLock(
          Effect.sync(() => {
            Deferred.doneUnsafe(ownerRecord.handleReady, Effect.succeed(handle));
            const record = tasks.get(id);
            if (record !== ownerRecord || !isActiveTaskState(ownerRecord.snapshot.state)) {
              return true;
            }
            const stopping = ownerRecord.snapshot.state === "stopping";
            ownerRecord.snapshot = {
              ...ownerRecord.snapshot,
              state: stopping ? "stopping" : "running",
              pid: handle.pid,
            };
            wake(ownerRecord);
            publish();
            return stopping;
          }),
        );
        if (terminateLateHandle) {
          yield* handle.terminate("force").pipe(Effect.ignore);
        }
        const outputFiber = yield* handle.output.pipe(
          Stream.runForEach((event) =>
            appendOutput(id, event.stream, event.text, event.droppedBytes),
          ),
          Effect.ignoreCause,
          Effect.forkScoped({ startImmediately: true }),
        );
        if (request.timeoutSeconds !== undefined) {
          yield* Effect.sleep(Duration.seconds(request.timeoutSeconds)).pipe(
            Effect.andThen(requestStop(id, false, "timed_out")),
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
            const record = tasks.get(id);
            if (record) {
              const unobservedDrops = Math.max(
                0,
                handle.droppedOutputBytes() - record.ingressDroppedObserved,
              );
              record.logs.addDropped(unobservedDrops);
              record.ingressDroppedObserved += unobservedDrops;
              completeRecord(record, exit, endedAt);
            }
          }),
        );
      }),
    ).pipe(
      Effect.catch((spawnError: LocalProcessError) =>
        withLock(
          Effect.gen(function* () {
            const record = tasks.get(id);
            Deferred.doneUnsafe(ownerRecord.handleReady, Effect.fail(spawnError));
            if (record !== ownerRecord || !isActiveTaskState(ownerRecord.snapshot.state)) return;
            const endedAt = yield* Clock.currentTimeMillis;
            ownerRecord.snapshot = {
              ...ownerRecord.snapshot,
              state: "failed",
              endedAt,
              error: spawnError.message,
            };
            wake(ownerRecord);
            Deferred.doneUnsafe(ownerRecord.completion, Effect.succeed(ownerRecord.snapshot));
            trimRetention();
            publish();
          }),
        ),
      ),
    );

  const start: BackgroundTaskServiceContract["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const command = request.command.trim();
        if (!command) {
          return yield* new InvalidBackgroundCommandError({
            message: "Background command must not be empty.",
          });
        }
        if (command.length > BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars) {
          return yield* new InvalidBackgroundCommandError({
            message: `Background command must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxCommandChars} characters.`,
          });
        }
        const name = request.name?.trim();
        if ((name?.length ?? 0) > BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars) {
          return yield* new InvalidBackgroundCommandError({
            message: `Background task name must not exceed ${BACKGROUND_TASK_FIELD_BOUNDS.maxNameChars} characters.`,
          });
        }
        if (
          request.timeoutSeconds !== undefined &&
          (!Number.isFinite(request.timeoutSeconds) || request.timeoutSeconds <= 0)
        ) {
          return yield* new InvalidBackgroundCommandError({
            message: "Background timeout must be a positive finite number of seconds.",
          });
        }
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
          ...(request.timeoutSeconds !== undefined && {
            timeoutSeconds: request.timeoutSeconds,
          }),
        };
        const record = yield* withLock(
          Effect.gen(function* () {
            if (admissionsClosed || !config.enabled) {
              return yield* new BackgroundRuntimeClosedError({
                message: admissionsClosed
                  ? "Background task runtime is closed."
                  : "Background tasks are disabled.",
              });
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
              logs: LogBuffer.empty(),
              wake: Deferred.makeUnsafe<void>(),
              completion: Deferred.makeUnsafe<BackgroundTaskSnapshot>(),
              handleReady: Deferred.makeUnsafe<LocalProcessHandle, LocalProcessError>(),
              ingressDroppedObserved: 0,
              awaiters: 0,
            };
            tasks.set(id, created);
            publish();
            return created;
          }),
        );
        yield* monitor(record.snapshot.id, record, prepared).pipe(
          Effect.forkIn(monitorScope, { startImmediately: true }),
        );
        return yield* restore(Deferred.await(record.handleReady)).pipe(
          Effect.andThen(Effect.sync(() => record.snapshot)),
          Effect.mapError((error) =>
            error.reason === "cwd"
              ? new InvalidBackgroundCwdError({ cwd, message: error.message })
              : new BackgroundSpawnError({ message: error.message }),
          ),
        );
      }),
    );

  const list: BackgroundTaskServiceContract["list"] = (filter = "all") =>
    withLock(
      Effect.sync(() =>
        sortTasksByActivity(
          [...tasks.values()]
            .map((record) => record.snapshot)
            .filter((snapshot) =>
              filter === "all"
                ? true
                : filter === "active"
                  ? isActiveTaskState(snapshot.state)
                  : !isActiveTaskState(snapshot.state),
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
        return record ? Effect.succeed(record) : Effect.fail(notFound(id));
      }),
    );

  const logs: BackgroundTaskServiceContract["logs"] = (request) =>
    Effect.gen(function* () {
      const record = yield* admitRecord(request.id);
      const prepared = yield* withLock(
        Effect.sync(() => {
          const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, request);
          const shouldWait =
            (request.waitSeconds ?? 0) > 0 &&
            slice.events.length === 0 &&
            isActiveTaskState(record.snapshot.state);
          return { slice, wake: shouldWait ? record.wake : undefined };
        }),
      );
      if (!prepared.wake) return prepared.slice;
      yield* Deferred.await(prepared.wake).pipe(
        Effect.timeoutOption(
          Duration.seconds(Math.min(request.waitSeconds ?? 0, config.maxWaitSeconds)),
        ),
      );
      return yield* withLock(
        Effect.sync(() => readLogBuffer(request.id, record.logs, record.snapshot.state, request)),
      );
    });

  const wait: BackgroundTaskServiceContract["wait"] = (request) =>
    Effect.gen(function* () {
      const waitSeconds = request.waitSeconds ?? config.maxWaitSeconds;
      if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
        return yield* new InvalidBackgroundCommandError({
          message: "Background task wait must be a non-negative finite number of seconds.",
        });
      }
      if (
        request.afterCursor !== undefined &&
        (!Number.isInteger(request.afterCursor) || request.afterCursor < 0)
      ) {
        return yield* new InvalidBackgroundCommandError({
          message: "Background task wait cursor must be a non-negative integer.",
        });
      }
      const contains = request.contains;
      if (
        request.until === "exit" &&
        (contains !== undefined || request.afterCursor !== undefined)
      ) {
        return yield* new InvalidBackgroundCommandError({
          message: "contains and afterCursor are valid only when waiting for output.",
        });
      }
      if (
        request.until === "output" &&
        (!contains ||
          contains.length > BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars ||
          contains.includes("\0"))
      ) {
        return yield* new InvalidBackgroundCommandError({
          message: `Output waits require a non-empty contains value of at most ${BACKGROUND_TASK_FIELD_BOUNDS.maxContainsChars} characters with no NUL byte.`,
        });
      }

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
      const timeoutMillis = Math.min(waitSeconds, config.maxWaitSeconds) * 1_000;
      const deadline = (yield* Clock.currentTimeMillis) + timeoutMillis;
      let scanAfterCursor = request.afterCursor ?? 0;
      const carryByStream = { stdout: "", stderr: "" } satisfies Record<
        BackgroundLogStream,
        string
      >;

      const inspect = (): Effect.Effect<WaitInspection> =>
        withLock(
          Effect.sync((): WaitInspection => {
            const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, {
              afterCursor: scanAfterCursor,
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
              if (matchCursor !== undefined) {
                return {
                  _tag: "result",
                  result: waitResult(record.snapshot, slice, "matched", matchCursor),
                };
              }
            }
            if (!isActiveTaskState(record.snapshot.state)) {
              return {
                _tag: "result",
                result: waitResult(record.snapshot, slice, "completed"),
              };
            }
            return {
              _tag: "pending",
              awaitChange:
                request.until === "exit"
                  ? Deferred.await(record.completion).pipe(Effect.asVoid)
                  : Deferred.await(record.wake),
              snapshot: record.snapshot,
              slice,
            };
          }),
        );

      while (true) {
        const inspected = yield* inspect();
        if (inspected._tag === "result") return inspected.result;
        const remainingMillis = deadline - (yield* Clock.currentTimeMillis);
        if (remainingMillis <= 0) {
          return waitResult(inspected.snapshot, inspected.slice, "timeout");
        }
        const awakened = yield* inspected.awaitChange.pipe(
          Effect.timeoutOption(Duration.millis(remainingMillis)),
        );
        if (Option.isNone(awakened)) {
          const finalInspection = yield* inspect();
          return finalInspection._tag === "result"
            ? finalInspection.result
            : waitResult(finalInspection.snapshot, finalInspection.slice, "timeout");
        }
      }
    }).pipe(Effect.scoped);

  const stop: BackgroundTaskServiceContract["stop"] = (id, force) => requestStop(id, force);
  const stopAll: BackgroundTaskServiceContract["stopAll"] = (force = false) =>
    Effect.gen(function* () {
      const ids = yield* withLock(
        Effect.sync(() =>
          [...tasks.values()]
            .filter((record) => isActiveTaskState(record.snapshot.state))
            .map((record) => record.snapshot.id),
        ),
      );
      // Partition isolates typed failures; interruption and defects still interrupt the batch.
      const [failures, settled] = yield* Effect.partition(
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
    stop,
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
