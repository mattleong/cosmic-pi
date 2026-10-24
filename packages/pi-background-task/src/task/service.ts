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
import { clipText } from "pi-cosmic-core/display";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { sanitizeDiagnosticError } from "pi-cosmic-core/security";
import { synchronousRandomToken } from "pi-cosmic-core/platform/native-crypto";
import { utf8ByteLength } from "pi-cosmic-core/text";
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
  notifiesOn,
  sortTasksByActivity,
  type BackgroundTaskNotice,
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
  claimFinishedNotice,
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

/** Who asked for a stop. The agent's own stops tell it the outcome, so they send no notice. */
export type StopRequester = "agent" | "user";

/**
 * Reads answer the agent: a finished state that `list`, `status`, `logs`, or `wait` reports, or that
 * the agent's `stop` finds, claims the task's exit notice, which is then never sent.
 */
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
  /** An explicit stop, by the user unless stated; repeating it while stopping escalates to force. */
  readonly stop: (
    id: string,
    force?: boolean,
    requester?: StopRequester,
  ) => Effect.Effect<BackgroundTaskStopResult, BackgroundTaskError>;
  /**
   * Explicitly stops every active task, escalating those already stopping. Returns the tasks it
   * stopped, leaving out any that finished on their own before their stop landed.
   */
  readonly stopAll: (
    force?: boolean,
    requester?: StopRequester,
  ) => Effect.Effect<ReadonlyArray<BackgroundTaskStatus>, BackgroundTaskError>;
  readonly clear: Effect.Effect<number>;
}

export interface BackgroundTaskServiceOptions {
  readonly publish?: (projection: BackgroundTaskProjection) => void;
  /** Delivers a finished task's notice to the agent; the host checks its own authority. */
  readonly notify?: (notice: BackgroundTaskNotice) => void;
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

/** What one inspection under the lock found: a result, or the change to wait for. */
type Poll<A> =
  | { readonly done: true; readonly value: A }
  | { readonly done: false; readonly change: Effect.Effect<unknown> };

/** Explicit stops escalate a stopping task to force; internal stops join its grace window. */
type StopRequest = StopRequester | "internal";

const checkCursor = (record: TaskRecord, afterCursor: number | undefined) =>
  Effect.suspend(() => {
    const latest = record.logs.latestCursor;
    return afterCursor === undefined || afterCursor <= latest
      ? Effect.void
      : Effect.fail(afterCursorAhead(record.snapshot.id, afterCursor, latest));
  });

// Random IDs keep a model from predicting the next one before its start returns.
const freshTaskId = (tasks: TaskRegistry): string => {
  let id = `task-${synchronousRandomToken()}`;
  while (tasks.has(id)) id = `task-${synchronousRandomToken()}`;
  return id;
};

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
  // A notice waits for the reads in progress, which may report the finish to the agent instead.
  // Shutdown and replacement close admission first, so a retiring runtime sends none.
  const deliverDueNotice = (record: TaskRecord) => {
    if (!record.noticeDue || record.readers > 0) return;
    record.noticeDue = false;
    if (record.noticeClaimed || admissionsClosed || !options.notify) return;
    const notice: BackgroundTaskNotice = {
      task: record.snapshot,
      recent: readLogBuffer(record.snapshot.id, record.logs, record.snapshot.state, {
        tailLines: BACKGROUND_LOG_BOUNDS.recentOutputLines,
      }),
      // A clear or retention trim may have removed the task while reads were in progress.
      retained: tasks.get(record.snapshot.id) === record,
    };
    invokeHostCallback(() => options.notify?.(notice), undefined);
  };
  const settle = (record: TaskRecord, snapshot: BackgroundTaskStatus) => {
    record.snapshot = snapshot;
    wakeTaskRecord(record);
    Deferred.doneUnsafe(record.completion, Effect.succeed(snapshot));
    record.noticeDue = record.notify !== undefined && notifiesOn(record.notify, snapshot);
    trimRetention(tasks, config.maxRetained);
    deliverDueNotice(record);
    publish();
  };
  /** Counts a read that may report the task's finish, for as long as the read runs. */
  const trackReader = (record: TaskRecord, waits: boolean) =>
    Effect.acquireRelease(
      withLock(
        Effect.sync(() => {
          record.readers += 1;
          if (!waits) return;
          record.awaiters += 1;
          publish();
        }),
      ),
      () =>
        withLock(
          Effect.sync(() => {
            record.readers -= 1;
            deliverDueNotice(record);
            if (!waits) return;
            record.awaiters -= 1;
            publish();
          }),
        ),
    );

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
            for (const terminal of Rec.values(record.terminal)) terminal.outputLost();
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
    reportsFinish = false,
  ) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const prepared = yield* withLock(
          Effect.gen(function* () {
            const record = tasks.get(id);
            if (!record) return yield* backgroundTaskNotFound(id);
            if (!isActiveTaskState(record.snapshot.state)) {
              // The agent's stop result says the task had already finished.
              if (reportsFinish) claimFinishedNotice(record);
              return { record, owner: false, joins: false, terminal: record.snapshot };
            }
            if (request === "agent") record.noticeClaimed = true;
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
          record.logs.addDropped(unobservedDrops).finish(endedAt, config.logBufferBytesPerTask);
          record.ingressDroppedObserved += unobservedDrops;
          enforceRetainedLogBudget(tasks, config.totalLogBufferBytes);
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
              // The start that is waiting for this task reports the failure.
              record.noticeClaimed = true;
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
            const id = yield* Effect.sync(() => freshTaskId(tasks));
            const startedAt = yield* Clock.currentTimeMillis;
            // The record keeps a display copy; the monitor runs the full prepared command.
            const created = taskRecord(
              {
                id,
                command: clipText(command, BACKGROUND_TASK_FIELD_BOUNDS.maxCommandDisplayChars),
                cwd,
                state: "starting",
                startedAt,
                logCursor: 0,
                droppedLogBytes: 0,
                ...(name && { name }),
              },
              prepared.notify,
            );
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
          Arr.flatMap([...tasks.values()], (record) => {
            const { snapshot } = record;
            if (filter !== "all" && isActiveTaskState(snapshot.state) !== (filter === "active"))
              return [];
            claimFinishedNotice(record);
            return [snapshot];
          }),
        ),
      ),
    );

  const status: BackgroundTaskServiceContract["status"] = (id) =>
    withLock(
      Effect.suspend(() => {
        const record = tasks.get(id);
        if (!record) return Effect.fail(backgroundTaskNotFound(id));
        claimFinishedNotice(record);
        return Effect.succeed(record.snapshot);
      }),
    );

  const admitRecord = (id: string): Effect.Effect<TaskRecord, BackgroundTaskNotFoundError> =>
    withLock(
      Effect.suspend(() => {
        const record = tasks.get(id);
        return record ? Effect.succeed(record) : Effect.fail(backgroundTaskNotFound(id));
      }),
    );

  /**
   * Inspects the task under the lock until `inspect` returns a value, waiting for its change in
   * between. Once the deadline passes, `inspect` is told so and returns what it has.
   */
  const pollUntil = Effect.fn("BackgroundTaskService.pollUntil")(function* <A>(
    deadline: number,
    inspect: (expired: boolean) => Poll<A>,
  ) {
    while (true) {
      const expired = (yield* monotonicMillis) >= deadline;
      const poll = yield* withLock(Effect.sync(() => inspect(expired)));
      if (poll.done) return poll.value;
      const remainingMillis = Math.max(0, deadline - (yield* monotonicMillis));
      yield* poll.change.pipe(Effect.timeoutOption(Duration.millis(remainingMillis)));
    }
  });

  const logs = Effect.fn("BackgroundTaskService.logs")(
    function* (request: ReadBackgroundLogs) {
      const record = yield* admitRecord(request.id);
      yield* withLock(checkCursor(record, request.afterCursor));
      yield* trackReader(record, false);
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
      return yield* pollUntil(deadline, (expired): Poll<BackgroundTaskLogs> => {
        const { snapshot } = record;
        const slice = readLogBuffer(request.id, record.logs, snapshot.state, window);
        if (!expired && slice.events.length === 0 && isActiveTaskState(snapshot.state))
          return { done: false, change: Deferred.await(record.wake) };
        const task = Object.freeze({
          ...(snapshot.name !== undefined && { name: snapshot.name }),
          command: snapshot.command,
        });
        claimFinishedNotice(record);
        return { done: true, value: Object.freeze({ ...slice, task }) };
      });
    },
    (effect) => Effect.scoped(effect),
  );

  const wait = Effect.fn("BackgroundTaskService.wait")(
    function* (request: WaitForBackgroundTask) {
      const waitSeconds = request.waitSeconds ?? config.maxWaitSeconds;
      yield* validateWaitRequest(request, waitSeconds);

      const record = yield* admitRecord(request.id);
      const alternatives = request.until === "output" ? (request.contains ?? []) : [];
      // Whether earlier output ended its line decides how a matched line's start is shown.
      const matcher = yield* withLock(
        checkCursor(record, request.afterCursor).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (alternatives.length === 0)
                return new OutputMatcher(alternatives, { afterCursor: request.afterCursor ?? 0 });
              // Without a cursor the wait scans retained output, so neither eviction nor the gap
              // just before the oldest retained event skips any of it; with nothing evicted, it
              // scans all output.
              const buffer = record.logs;
              const afterCursor = request.afterCursor ?? buffer.earliestCursor;
              const retainedOnly = request.afterCursor === undefined && afterCursor > 0;
              return new OutputMatcher(alternatives, {
                afterCursor,
                linesEnded: buffer.linesEndedAt(afterCursor),
                ...(retainedOnly && { ignoredGapBytes: buffer.oldestEvent?.droppedBefore ?? 0 }),
              });
            }),
          ),
        ),
      );
      yield* trackReader(record, true);
      const appliedWaitSeconds = Math.min(waitSeconds, config.maxWaitSeconds);
      const deadline = (yield* monotonicMillis) + appliedWaitSeconds * 1_000;

      return yield* pollUntil(deadline, (expired): Poll<BackgroundTaskStatusWait> => {
        const { state } = record.snapshot;
        const slice = readLogBuffer(request.id, record.logs, state, {
          afterCursor: matcher.afterCursor,
        });
        const match = matcher.match(slice);
        const outcome: BackgroundTaskWaitResult["outcome"] | undefined = match
          ? "matched"
          : !isActiveTaskState(state)
            ? "completed"
            : expired
              ? "timeout"
              : undefined;
        if (outcome === undefined)
          return {
            done: false,
            change:
              request.until === "exit"
                ? Deferred.await(record.completion)
                : Deferred.await(record.wake),
          };
        // A wait that returns now reports a finished state to the agent.
        claimFinishedNotice(record);
        const { skipped } = matcher;
        return {
          done: true,
          value: {
            id: record.snapshot.id,
            outcome,
            snapshot: record.snapshot,
            nextCursor: slice.nextCursor,
            earliestAvailableCursor: slice.earliestAvailableCursor,
            droppedBytes: slice.droppedBytes,
            ...(skipped && { skipped }),
            ...(match && {
              matchCursor: match.cursor,
              matchedText: match.text,
              matchedLine: match.line,
            }),
            appliedWaitSeconds,
            recent: readLogBuffer(request.id, record.logs, state, {
              tailLines: BACKGROUND_LOG_BOUNDS.recentOutputLines,
            }),
          },
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
    stop: (id, force = false, requester = "user") =>
      requestStop(id, force, requester, "stopped", requester === "agent"),
    stopAll: (force = false, requester = "user") => stopAll(force, requester),
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
