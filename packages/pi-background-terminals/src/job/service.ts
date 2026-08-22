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
  type LocalProcessHandle,
} from "../boundary/local-process.ts";
import { BackgroundTerminalConfigStore } from "../config/store.ts";
import {
  BackgroundJobCapacityError,
  BackgroundJobNotFoundError,
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
  BackgroundTerminationError,
  InvalidBackgroundCommandError,
  InvalidBackgroundCwdError,
  type BackgroundTerminalError,
} from "./errors.ts";
import {
  addDroppedLogBytes,
  appendLog,
  dropOldestLogEvent,
  emptyLogBuffer,
  readLogBuffer,
  type LogBuffer,
} from "./log-buffer.ts";
import {
  isActiveJobState,
  type BackgroundJobSnapshot,
  type BackgroundJobState,
  type BackgroundLogSlice,
  type BackgroundTerminalProjection,
  type ReadBackgroundLogs,
  type StartBackgroundJob,
} from "./model.ts";
import { sortJobsByActivity } from "./projection.ts";

interface JobRecord {
  snapshot: BackgroundJobSnapshot;
  logs: LogBuffer;
  wake: Deferred.Deferred<void>;
  completion: Deferred.Deferred<BackgroundJobSnapshot>;
  handleReady: Deferred.Deferred<LocalProcessHandle, LocalProcessError>;
  terminationStarted: boolean;
  terminalOutcome?: "stopped" | "timed_out";
  ingressDroppedObserved: number;
}

export type BackgroundJobFilter = "active" | "completed" | "all";

export interface BackgroundTerminalServiceContract {
  readonly start: (
    request: StartBackgroundJob,
  ) => Effect.Effect<BackgroundJobSnapshot, BackgroundTerminalError>;
  readonly list: (
    filter?: BackgroundJobFilter,
  ) => Effect.Effect<ReadonlyArray<BackgroundJobSnapshot>>;
  readonly status: (id: string) => Effect.Effect<BackgroundJobSnapshot, BackgroundJobNotFoundError>;
  readonly logs: (
    request: ReadBackgroundLogs,
  ) => Effect.Effect<BackgroundLogSlice, BackgroundJobNotFoundError>;
  readonly stop: (
    id: string,
    force?: boolean,
  ) => Effect.Effect<BackgroundJobSnapshot, BackgroundTerminalError>;
  readonly stopAll: (
    force?: boolean,
  ) => Effect.Effect<ReadonlyArray<BackgroundJobSnapshot>, BackgroundTerminalError>;
  readonly clear: Effect.Effect<number>;
  readonly projection: Effect.Effect<BackgroundTerminalProjection>;
}

export interface BackgroundTerminalServiceOptions {
  readonly publish?: (projection: BackgroundTerminalProjection) => void;
}

const notFound = (id: string) =>
  new BackgroundJobNotFoundError({ id, message: `Background job not found: ${id}` });

/** Output chunks coalesce into at most one projection publish per interval. */
const OUTPUT_PUBLISH_INTERVAL_MILLIS = 1_000;

const makeService = Effect.fn("BackgroundTerminalService.make")(function* (
  options: BackgroundTerminalServiceOptions,
) {
  const config = yield* BackgroundTerminalConfigStore;
  const processes = yield* LocalProcess;
  const path = yield* Path.Path;
  const ownerScope = yield* Effect.scope;
  // The parent owns one fixed monitor scope. The service shutdown finalizer is registered later,
  // so it requests and confirms process settlement before the monitor scope is interrupted.
  const monitorScope = yield* Scope.fork(ownerScope);
  const lock = yield* Semaphore.make(1);
  const jobs = new Map<string, JobRecord>();
  let nextId = 1;
  // Open while the runtime admits starts; the shutdown finalizer closes it under the same
  // lock that guards admission.
  const admissions = yield* Latch.make(true);
  const retainedLogBudget = Math.max(1, Math.floor(config.totalLogBufferBytes / 2));
  const ingressLogBudget = Math.max(1, config.totalLogBufferBytes - retainedLogBudget);

  const withLock = lock.withPermits(1);
  const wake = (record: JobRecord) => {
    const current = record.wake;
    record.wake = Deferred.makeUnsafe<void>();
    Deferred.doneUnsafe(current, Effect.void);
  };
  const currentProjection = (): BackgroundTerminalProjection => ({
    jobs: sortJobsByActivity(
      [...jobs.values()].map((record) => ({
        ...record.snapshot,
        logs: record.logs.events,
      })),
    ),
  });
  let outputPublishPending = false;
  let outputPublishDeadline = 0;
  let outputFlushScheduled = false;
  const publish = () => {
    outputPublishPending = false;
    options.publish?.(currentProjection());
  };
  const flushOutputPublish = withLock(
    Effect.gen(function* () {
      outputFlushScheduled = false;
      if (!outputPublishPending) return;
      outputPublishDeadline = (yield* Clock.currentTimeMillis) + OUTPUT_PUBLISH_INTERVAL_MILLIS;
      publish();
    }),
  );
  const totalLogBytes = () =>
    [...jobs.values()].reduce((total, record) => total + record.logs.bytes, 0);
  const enforceTotalLogBudget = () => {
    let total = totalLogBytes();
    while (total > retainedLogBudget) {
      let selected: JobRecord | undefined;
      for (const record of jobs.values()) {
        const first = record.logs.oldestEvent;
        const selectedFirst = selected?.logs.oldestEvent;
        if (first && (!selectedFirst || first.timestamp < selectedFirst.timestamp))
          selected = record;
      }
      const dropped = selected?.logs.oldestEvent;
      if (!selected || !dropped) break;
      selected.logs = dropOldestLogEvent(selected.logs);
      total -= dropped.bytes;
      selected.snapshot = {
        ...selected.snapshot,
        droppedLogBytes: selected.logs.droppedBytes,
      };
      wake(selected);
    }
  };
  const trimRetention = () => {
    const completed = [...jobs.values()]
      .filter((record) => !isActiveJobState(record.snapshot.state))
      .sort((left, right) => (left.snapshot.endedAt ?? 0) - (right.snapshot.endedAt ?? 0));
    while (jobs.size > config.maxRetained && completed.length > 0) {
      const evicted = completed.shift();
      if (evicted) jobs.delete(evicted.snapshot.id);
    }
  };
  const completeRecord = (
    record: JobRecord,
    exit: { readonly exitCode: number | null; readonly signal?: string; readonly error?: string },
    endedAt: number,
  ) => {
    if (!isActiveJobState(record.snapshot.state)) return;
    const state: BackgroundJobState = record.terminalOutcome
      ? record.terminalOutcome
      : exit.error || exit.exitCode !== 0
        ? "failed"
        : "exited";
    const baseSnapshot = {
      ...record.snapshot,
      state,
      endedAt,
      exitCode: exit.exitCode,
    };
    const snapshotWithSignal = exit.signal
      ? { ...baseSnapshot, signal: exit.signal }
      : baseSnapshot;
    const snapshotWithError = exit.error
      ? { ...snapshotWithSignal, error: exit.error }
      : snapshotWithSignal;
    record.snapshot = {
      ...snapshotWithError,
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
        const record = jobs.get(id);
        if (!record || !isActiveJobState(record.snapshot.state)) return;
        const timestamp = yield* Clock.currentTimeMillis;
        record.logs = appendLog(
          addDroppedLogBytes(record.logs, droppedBytes),
          stream,
          text,
          timestamp,
          config.logBufferBytesPerJob,
        );
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
        } else if (!outputFlushScheduled) {
          outputFlushScheduled = true;
          yield* flushOutputPublish.pipe(
            Effect.delay(Duration.millis(OUTPUT_PUBLISH_INTERVAL_MILLIS)),
            Effect.forkIn(ownerScope, { startImmediately: true }),
          );
        }
      }),
    );

  type RequestStop = (
    id: string,
    force?: boolean,
    outcome?: "stopped" | "timed_out",
  ) => Effect.Effect<BackgroundJobSnapshot, BackgroundTerminalError>;
  let requestStop: RequestStop;

  const monitor = (id: string, ownerRecord: JobRecord, request: StartBackgroundJob) => {
    let handleAcquired = false;
    return Effect.scoped(
      Effect.gen(function* () {
        const spawnRequestBase = {
          command: request.command,
          cwd: request.cwd,
          ingressBufferBytes: Math.max(
            1,
            Math.min(config.logBufferBytesPerJob, Math.floor(ingressLogBudget / config.maxRunning)),
          ),
        };
        const handle = yield* processes.spawn(
          config.shellPath
            ? { ...spawnRequestBase, shellPath: config.shellPath }
            : spawnRequestBase,
        );
        handleAcquired = true;
        const terminateLateHandle = yield* withLock(
          Effect.sync(() => {
            Deferred.doneUnsafe(ownerRecord.handleReady, Effect.succeed(handle));
            const record = jobs.get(id);
            if (record !== ownerRecord || !isActiveJobState(ownerRecord.snapshot.state)) {
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
          yield* handle.terminate("force").pipe(Effect.catch(() => Effect.void));
        }
        const outputFiber = yield* Stream.fromQueue(handle.output).pipe(
          Stream.runForEach((event) =>
            appendOutput(id, event.stream, event.text, event.droppedBytes),
          ),
          Effect.catchCause(() => Effect.void),
          Effect.forkScoped({ startImmediately: true }),
        );
        if (request.timeoutSeconds !== undefined) {
          yield* Effect.sleep(Duration.seconds(request.timeoutSeconds)).pipe(
            Effect.andThen(requestStop(id, false, "timed_out")),
            Effect.catch(() => Effect.void),
            Effect.forkScoped({ startImmediately: true }),
          );
        }
        const exit = yield* handle.awaitExit;
        const drained = yield* Fiber.await(outputFiber).pipe(Effect.timeoutOption("1 second"));
        if (Option.isNone(drained)) yield* Fiber.interrupt(outputFiber);
        const endedAt = yield* Clock.currentTimeMillis;
        yield* withLock(
          Effect.sync(() => {
            const record = jobs.get(id);
            if (record) {
              const unobservedDrops = Math.max(
                0,
                handle.droppedOutputBytes() - record.ingressDroppedObserved,
              );
              record.logs = addDroppedLogBytes(record.logs, unobservedDrops);
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
            const record = jobs.get(id);
            Deferred.doneUnsafe(ownerRecord.handleReady, Effect.fail(spawnError));
            if (record !== ownerRecord || !isActiveJobState(ownerRecord.snapshot.state)) return;
            // A stopping job remains active until awaitExit confirms process settlement. Boundary
            // failure after acquisition cannot manufacture a terminal snapshot.
            if (handleAcquired && ownerRecord.snapshot.state === "stopping") {
              wake(ownerRecord);
              publish();
              return;
            }
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
  };

  const start: BackgroundTerminalServiceContract["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const command = request.command.trim();
        if (!command) {
          return yield* new InvalidBackgroundCommandError({
            message: "Background command must not be empty.",
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
        const prepared = { ...request, command, cwd };
        const record = yield* withLock(
          Effect.gen(function* () {
            if (!admissions.isOpen() || !config.enabled) {
              return yield* new BackgroundRuntimeClosedError({
                message: admissions.isOpen()
                  ? "Background terminals are disabled."
                  : "Background terminal runtime is closed.",
              });
            }
            const active = [...jobs.values()].filter((item) =>
              isActiveJobState(item.snapshot.state),
            ).length;
            if (active >= config.maxRunning) {
              return yield* new BackgroundJobCapacityError({
                limit: config.maxRunning,
                message: `Background job capacity reached (${config.maxRunning}).`,
              });
            }
            const startedAt = yield* Clock.currentTimeMillis;
            const id = `term-${nextId++}`;
            const snapshot: BackgroundJobSnapshot = {
              id,
              command,
              cwd,
              state: "starting",
              startedAt,
              logCursor: 0,
              droppedLogBytes: 0,
            };
            const created: JobRecord = {
              snapshot: request.name?.trim()
                ? { ...snapshot, name: request.name.trim() }
                : snapshot,
              logs: emptyLogBuffer(),
              wake: Deferred.makeUnsafe<void>(),
              completion: Deferred.makeUnsafe<BackgroundJobSnapshot>(),
              handleReady: Deferred.makeUnsafe<LocalProcessHandle, LocalProcessError>(),
              terminationStarted: false,
              ingressDroppedObserved: 0,
            };
            jobs.set(id, created);
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
            error.operation === "inspect working directory"
              ? new InvalidBackgroundCwdError({ cwd, message: error.message })
              : new BackgroundSpawnError({ message: error.message }),
          ),
        );
      }),
    );

  const list: BackgroundTerminalServiceContract["list"] = (filter = "all") =>
    withLock(
      Effect.sync(() =>
        sortJobsByActivity(
          [...jobs.values()]
            .map((record) => record.snapshot)
            .filter((snapshot) =>
              filter === "all"
                ? true
                : filter === "active"
                  ? isActiveJobState(snapshot.state)
                  : !isActiveJobState(snapshot.state),
            ),
        ),
      ),
    );

  const status: BackgroundTerminalServiceContract["status"] = (id) =>
    withLock(
      Effect.suspend(() => {
        const record = jobs.get(id);
        return record ? Effect.succeed(record.snapshot) : Effect.fail(notFound(id));
      }),
    );

  const readLogs = (
    request: ReadBackgroundLogs,
    allowWait: boolean,
  ): Effect.Effect<BackgroundLogSlice, BackgroundJobNotFoundError> =>
    Effect.gen(function* () {
      const prepared = yield* withLock(
        Effect.suspend(() => {
          const record = jobs.get(request.id);
          if (!record) return Effect.fail(notFound(request.id));
          const slice = readLogBuffer(request.id, record.logs, record.snapshot.state, request);
          const shouldWait =
            allowWait &&
            (request.waitSeconds ?? 0) > 0 &&
            slice.events.length === 0 &&
            isActiveJobState(record.snapshot.state);
          return Effect.succeed({ slice, wake: shouldWait ? record.wake : undefined });
        }),
      );
      if (!prepared.wake) return prepared.slice;
      yield* Deferred.await(prepared.wake).pipe(
        Effect.timeoutOption(
          Duration.seconds(Math.min(request.waitSeconds ?? 0, config.maxLogWaitSeconds)),
        ),
      );
      return yield* readLogs({ ...request, waitSeconds: 0 }, false);
    });

  const logs: BackgroundTerminalServiceContract["logs"] = (request) => readLogs(request, true);

  type StopPreparation = {
    readonly record: JobRecord;
    readonly owner: boolean;
    readonly terminal?: BackgroundJobSnapshot;
  };

  requestStop = (id, force = false, outcome = "stopped") =>
    Effect.gen(function* () {
      const prepared = yield* withLock(
        Effect.suspend((): Effect.Effect<StopPreparation, BackgroundJobNotFoundError> => {
          const record = jobs.get(id);
          if (!record) return Effect.fail(notFound(id));
          if (!isActiveJobState(record.snapshot.state)) {
            return Effect.succeed({
              record,
              owner: false,
              terminal: record.snapshot,
            } satisfies StopPreparation);
          }
          const owner = !record.terminationStarted;
          record.terminationStarted = true;
          record.terminalOutcome ??= outcome;
          record.snapshot = { ...record.snapshot, state: "stopping" };
          wake(record);
          publish();
          return Effect.succeed({ record, owner } satisfies StopPreparation);
        }),
      );
      if (prepared.terminal) return prepared.terminal;

      const handleResult = yield* Deferred.await(prepared.record.handleReady).pipe(
        Effect.option,
        Effect.timeoutOption("5 seconds"),
      );
      const handle =
        Option.isSome(handleResult) && Option.isSome(handleResult.value)
          ? handleResult.value.value
          : undefined;
      const terminate = (mode: "graceful" | "force") =>
        handle
          ? handle.terminate(mode).pipe(
              Effect.mapError(
                (error) =>
                  new BackgroundTerminationError({
                    id,
                    message: error.message,
                  }),
              ),
            )
          : Effect.void;

      if (force) {
        yield* terminate("force");
      } else if (prepared.owner) {
        yield* terminate("graceful");
        const settled = yield* Deferred.await(prepared.record.completion).pipe(
          Effect.timeoutOption(Duration.millis(config.stopGraceMs)),
        );
        if (Option.isNone(settled)) yield* terminate("force");
      }

      const finalWait = yield* Deferred.await(prepared.record.completion).pipe(
        Effect.timeoutOption(Duration.millis(Math.max(5_000, config.stopGraceMs + 5_000))),
      );
      if (Option.isSome(finalWait)) return finalWait.value;
      return yield* new BackgroundTerminationError({
        id,
        message: "Background process did not confirm exit after forced termination.",
      });
    });

  const stop: BackgroundTerminalServiceContract["stop"] = (id, force) => requestStop(id, force);
  const stopAll: BackgroundTerminalServiceContract["stopAll"] = (force = false) =>
    Effect.gen(function* () {
      const ids = yield* withLock(
        Effect.sync(() =>
          [...jobs.values()]
            .filter((record) => isActiveJobState(record.snapshot.state))
            .map((record) => record.snapshot.id),
        ),
      );
      return yield* Effect.forEach(ids, (id) => requestStop(id, force), {
        concurrency: Math.min(ids.length || 1, 8),
      });
    });
  const clear = withLock(
    Effect.sync(() => {
      let removed = 0;
      for (const [id, record] of jobs) {
        if (isActiveJobState(record.snapshot.state)) continue;
        jobs.delete(id);
        removed += 1;
      }
      if (removed > 0) publish();
      return removed;
    }),
  );
  const projection = withLock(Effect.sync(currentProjection));

  const service: BackgroundTerminalServiceContract = {
    start,
    list,
    status,
    logs,
    stop,
    stopAll,
    clear,
    projection,
  };

  yield* Effect.addFinalizer(() =>
    withLock(Latch.close(admissions)).pipe(
      Effect.andThen(stopAll(false)),
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    ),
  );

  return service;
});

export class BackgroundTerminalService extends Context.Service<
  BackgroundTerminalService,
  BackgroundTerminalServiceContract
>()("pi-background-terminals/job/service/BackgroundTerminalService") {
  static readonly layer = (options: BackgroundTerminalServiceOptions = {}) =>
    Layer.effect(this, makeService(options));

  static override readonly use = <A, E>(
    f: (service: BackgroundTerminalServiceContract) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}
