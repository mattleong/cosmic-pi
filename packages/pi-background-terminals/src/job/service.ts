import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
import { BackgroundTerminalConfigStore } from "../config/store.ts";
import {
  BackgroundJobCapacityError,
  BackgroundJobNotFoundError,
  BackgroundRuntimeClosedError,
  BackgroundSpawnError,
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

export interface BackgroundTerminalServiceShape {
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

const makeService = Effect.fn("BackgroundTerminalService.make")(function* (
  options: BackgroundTerminalServiceOptions,
) {
  const config = yield* BackgroundTerminalConfigStore;
  const processes = yield* LocalProcess;
  const path = yield* Path.Path;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const jobs = new Map<string, JobRecord>();
  let nextId = 1;
  let closed = false;
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
  const publish = () => {
    options.publish?.(currentProjection());
  };
  const totalLogBytes = () =>
    [...jobs.values()].reduce((total, record) => total + record.logs.bytes, 0);
  const enforceTotalLogBudget = () => {
    while (totalLogBytes() > retainedLogBudget) {
      let selected: JobRecord | undefined;
      for (const record of jobs.values()) {
        const first = record.logs.events[0];
        const selectedFirst = selected?.logs.events[0];
        if (first && (!selectedFirst || first.timestamp < selectedFirst.timestamp))
          selected = record;
      }
      if (!selected) break;
      selected.logs = dropOldestLogEvent(selected.logs);
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
    record.snapshot = {
      ...record.snapshot,
      state,
      endedAt,
      exitCode: exit.exitCode,
      ...(exit.signal ? { signal: exit.signal } : {}),
      ...(exit.error ? { error: exit.error } : {}),
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
        publish();
      }),
    );

  type RequestStop = (
    id: string,
    force?: boolean,
    outcome?: "stopped" | "timed_out",
  ) => Effect.Effect<BackgroundJobSnapshot, BackgroundTerminalError>;
  let requestStop: RequestStop;

  const monitor = (id: string, ownerRecord: JobRecord, request: StartBackgroundJob) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* processes.spawn({
          command: request.command,
          cwd: request.cwd,
          ingressBufferBytes: Math.max(
            1,
            Math.min(config.logBufferBytesPerJob, Math.floor(ingressLogBudget / config.maxRunning)),
          ),
          ...(config.shellPath ? { shellPath: config.shellPath } : {}),
        });
        const terminateLateHandle = yield* withLock(
          Effect.sync(() => {
            Deferred.doneUnsafe(ownerRecord.handleReady, Effect.succeed(handle));
            const record = jobs.get(id);
            if (record !== ownerRecord || !isActiveJobState(ownerRecord.snapshot.state)) {
              return true;
            }
            ownerRecord.snapshot = {
              ...ownerRecord.snapshot,
              state: ownerRecord.snapshot.state === "stopping" ? "stopping" : "running",
              pid: handle.pid,
            };
            wake(ownerRecord);
            publish();
            return false;
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
          yield* Effect.sleep(`${request.timeoutSeconds} seconds`).pipe(
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

  const start: BackgroundTerminalServiceShape["start"] = (request) =>
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
            if (closed || !config.enabled) {
              return yield* new BackgroundRuntimeClosedError({
                message: closed
                  ? "Background terminal runtime is closed."
                  : "Background terminals are disabled.",
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
            const created: JobRecord = {
              snapshot: {
                id,
                command,
                cwd,
                state: "starting",
                startedAt,
                logCursor: 0,
                droppedLogBytes: 0,
                ...(request.name?.trim() ? { name: request.name.trim() } : {}),
              },
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
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        yield* Scope.addFinalizer(
          ownerScope,
          requestStop(record.snapshot.id, false).pipe(
            Effect.asVoid,
            Effect.catch(() => Effect.void),
          ),
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

  const list: BackgroundTerminalServiceShape["list"] = (filter = "all") =>
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

  const status: BackgroundTerminalServiceShape["status"] = (id) =>
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
          `${Math.min(request.waitSeconds ?? 0, config.maxLogWaitSeconds)} seconds`,
        ),
      );
      return yield* readLogs({ ...request, waitSeconds: 0 }, false);
    });

  const logs: BackgroundTerminalServiceShape["logs"] = (request) => readLogs(request, true);

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
      let terminationError: string | undefined;
      const terminate = (mode: "graceful" | "force") =>
        handle
          ? handle.terminate(mode).pipe(
              Effect.match({
                onFailure: (error) => {
                  terminationError = error.message;
                },
                onSuccess: () => undefined,
              }),
            )
          : Effect.void;

      if (force) {
        yield* terminate("force");
      } else if (prepared.owner) {
        yield* terminate("graceful");
        const settled = yield* Deferred.await(prepared.record.completion).pipe(
          Effect.timeoutOption(`${config.stopGraceMs} millis`),
        );
        if (Option.isNone(settled)) yield* terminate("force");
      }

      const finalWait = yield* Deferred.await(prepared.record.completion).pipe(
        Effect.timeoutOption(`${Math.max(5_000, config.stopGraceMs + 5_000)} millis`),
      );
      if (Option.isSome(finalWait)) return finalWait.value;

      const message =
        terminationError ?? "Background process did not settle after forced termination.";
      return yield* withLock(
        Effect.gen(function* () {
          const record = jobs.get(id);
          if (!record) return yield* notFound(id);
          if (isActiveJobState(record.snapshot.state)) {
            const endedAt = yield* Clock.currentTimeMillis;
            completeRecord(record, { exitCode: null, error: message }, endedAt);
          }
          return record.snapshot;
        }),
      );
    });

  const stop: BackgroundTerminalServiceShape["stop"] = (id, force) => requestStop(id, force);
  const stopAll: BackgroundTerminalServiceShape["stopAll"] = (force = false) =>
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

  const service: BackgroundTerminalServiceShape = {
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
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(stopAll(false)),
      Effect.asVoid,
      Effect.catch(() => Effect.void),
    ),
  );

  return service;
});

export class BackgroundTerminalService extends Context.Service<
  BackgroundTerminalService,
  BackgroundTerminalServiceShape
>()("pi-background-terminals/job/service/BackgroundTerminalService") {
  static readonly layer = (options: BackgroundTerminalServiceOptions = {}) =>
    Layer.effect(this, makeService(options));

  static override readonly use = <A, E>(
    f: (service: BackgroundTerminalServiceShape) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}
