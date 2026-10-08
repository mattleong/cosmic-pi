import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BackendHandle } from "../backend/model.ts";
import type { RunContext, RunRecord, WithRunLock } from "./internal.ts";
import type { SubagentError } from "./errors.ts";
import { invalidRequest, SubagentProcessError } from "./errors.ts";
import type { RunEventHandler } from "./events.ts";
import { isTerminalRunState } from "./model.ts";
import type { RunRecordCleanup } from "./record-cleanup.ts";
import type { RunSettlement } from "./settlement.ts";
import type { WriterPreparation } from "./writer-preparation.ts";

export function makeRunProcessControls(withLock: WithRunLock) {
  const runControl = <A>(
    record: RunRecord,
    use: (handle: BackendHandle) => Effect.Effect<A, SubagentError>,
  ): Effect.Effect<A, SubagentError> =>
    Effect.gen(function* () {
      const transport = yield* withLock(
        Effect.gen(function* () {
          const process = record.process;
          if (
            !process ||
            record.stoppedByParent ||
            record.cleanupPending ||
            record.view.state === "stopping" ||
            isTerminalRunState(record.view.state)
          )
            return yield* new SubagentProcessError({
              operation: "control",
              message: `Subagent ${record.view.id} has no active backend handle.`,
            });
          return yield* use(process).pipe(Effect.forkChild({ startImmediately: true }));
        }),
      );
      return yield* Fiber.join(transport);
    });

  return {
    initialize: (record: RunRecord) => runControl(record, (process) => process.controls.initialize),
    startPrompt: (record: RunRecord, message: string, assignmentEpoch: number) =>
      runControl(record, (process) => process.controls.start(message, assignmentEpoch)),
    steer: (record: RunRecord, message: string) =>
      runControl(record, (process) => process.controls.steer(message)),
    interrupt: (record: RunRecord) => runControl(record, (process) => process.controls.interrupt),
    renameDisplay: (record: RunRecord, name: string) =>
      runControl(record, (process) => process.controls.renameDisplay(name)),
  };
}

export type RunProcessControls = ReturnType<typeof makeRunProcessControls>;

export interface RunProcessInitializerDependencies extends RunContext {
  readonly initialize: RunProcessControls["initialize"];
  readonly handleBackendEvent: RunEventHandler;
  /** Must durably confirm writer spawn-started evidence before a driver spawn is invoked. */
  readonly prepareBackendSpawn: WriterPreparation;
  readonly markCleanupPending: RunRecordCleanup["markCleanupPending"];
  readonly closeExitedScope: RunRecordCleanup["closeExitedScope"];
  readonly failRun: RunSettlement["failRun"];
}

export function makeRunProcessInitializer(dependencies: RunProcessInitializerDependencies) {
  const {
    ownerScope,
    withLock,
    publish,
    initialize,
    handleBackendEvent,
    prepareBackendSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun,
  } = dependencies;

  const installProcess = (record: RunRecord) => {
    const scope = record.scope;
    return Effect.gen(function* () {
      yield* prepareBackendSpawn(record);
      const spawnSettled = yield* Deferred.make<void>();
      let spawnClaimed = false;
      // Install settlement before admission so permit waiting and driver work stay
      // interruptible without leaving cleanup waiting on an abandoned spawn claim.
      const process = yield* Effect.gen(function* () {
        yield* withLock(
          Effect.sync(() => {
            if (
              record.scope !== scope ||
              record.closingScope === scope ||
              record.stoppedByParent ||
              record.view.state === "stopping" ||
              record.view.state === "stopped" ||
              record.backendSpawnAttempt !== undefined
            )
              return;
            record.backendSpawnAttempt = { scope, settled: spawnSettled };
            spawnClaimed = true;
          }),
        );
        if (!spawnClaimed)
          return yield* invalidRequest(
            "start_cancelled",
            `Subagent ${record.view.id} was stopped before backend spawn.`,
          );
        return yield* record.driver
          .spawn(record.launch)
          .pipe(Effect.provideService(Scope.Scope, scope));
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            spawnClaimed
              ? withLock(
                  Effect.sync(() => {
                    if (record.backendSpawnAttempt?.settled === spawnSettled)
                      record.backendSpawnAttempt = undefined;
                    Deferred.doneUnsafe(spawnSettled, Effect.void);
                  }),
                )
              : Effect.void,
          ),
        ),
      );
      const attached = yield* withLock(
        Effect.gen(function* () {
          if (
            record.scope !== scope ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.process = process;
          record.view = {
            ...record.view,
            ...(process.pid !== undefined && { pid: process.pid }),
          };
          yield* publish;
          return true;
        }),
      );
      if (!attached)
        return yield* invalidRequest(
          "start_cancelled",
          `Subagent ${record.view.id} was stopped during startup.`,
        );
      const isCurrentProcess = withLock(
        Effect.sync(() => record.scope === scope && record.process === process),
      );
      const eventConsumer = yield* Stream.fromQueue(process.events).pipe(
        Stream.runForEach((event) =>
          isCurrentProcess.pipe(
            Effect.flatMap((isCurrent) =>
              isCurrent
                ? handleBackendEvent(record, event, process).pipe(
                    Effect.catch((error) =>
                      failRun(record, error.message, error).pipe(Effect.asVoid),
                    ),
                  )
                : Effect.void,
            ),
            Effect.ensuring(Effect.sync(() => process.acknowledge(event))),
          ),
        ),
        Effect.ignoreCause,
        Effect.forkIn(scope, { startImmediately: true }),
      );
      yield* process.awaitExit.pipe(
        Effect.flatMap((event) =>
          isCurrentProcess.pipe(
            Effect.flatMap((isCurrent) =>
              isCurrent
                ? markCleanupPending(record).pipe(
                    Effect.andThen(
                      Fiber.join(eventConsumer).pipe(
                        Effect.andThen(handleBackendEvent(record, event, process)),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        ),
        Effect.catch((error) => failRun(record, error.message, error).pipe(Effect.asVoid)),
        Effect.ensuring(
          closeExitedScope(record, scope).pipe(
            Effect.forkIn(ownerScope, { startImmediately: true }),
            Effect.asVoid,
          ),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      return process;
    });
  };

  return (record: RunRecord) => installProcess(record).pipe(Effect.andThen(initialize(record)));
}

export type RunProcessInitializer = ReturnType<typeof makeRunProcessInitializer>;
