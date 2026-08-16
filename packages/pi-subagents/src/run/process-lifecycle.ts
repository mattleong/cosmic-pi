import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { BackendEvent, BackendHandle } from "../backend/model.ts";
import type { RunRecord } from "./internal.ts";
import type { SubagentError } from "./errors.ts";
import { InvalidSubagentRequestError, SubagentProcessError } from "./errors.ts";
import { hasSubagentCapability, isActiveRunState, isTerminalRunState } from "./model.ts";
import { peerNoticeText } from "./coordination.ts";

export interface RunProcessLifecycleDependencies {
  readonly ownerScope: Scope.Scope;
  readonly records: ReadonlyMap<string, RunRecord>;
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly publish: () => void;
  readonly handleBackendEvent: (
    record: RunRecord,
    event: BackendEvent,
  ) => Effect.Effect<void, SubagentError>;
  /** Must durably confirm writer spawn-started evidence before a driver spawn is invoked. */
  readonly prepareBackendSpawn: (record: RunRecord) => Effect.Effect<void, SubagentError>;
  readonly markCleanupPending: (record: RunRecord) => Effect.Effect<void>;
  readonly closeExitedScope: (record: RunRecord, scope: Scope.Closeable) => Effect.Effect<void>;
  readonly failRun: (
    record: RunRecord,
    message: string,
    pendingError?: SubagentError,
  ) => Effect.Effect<unknown>;
}

export function makeRunProcessLifecycle(dependencies: RunProcessLifecycleDependencies) {
  const {
    ownerScope,
    records,
    withLock,
    publish,
    handleBackendEvent,
    prepareBackendSpawn,
    markCleanupPending,
    closeExitedScope,
    failRun,
  } = dependencies;

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
          return yield* use(process).pipe(Effect.forkIn(ownerScope, { startImmediately: true }));
        }),
      );
      return yield* Fiber.join(transport).pipe(
        Effect.onInterrupt(() => Fiber.interrupt(transport).pipe(Effect.asVoid)),
      );
    });

  const sendPeerNotices = (changedId: string) => {
    const recipients = [...records.values()].flatMap((record) => {
      const process = record.process;
      return process &&
        isActiveRunState(record.view.state) &&
        hasSubagentCapability(record.view, "peer-notice")
        ? [{ record, process }]
        : [];
    });
    return Effect.forEach(
      recipients,
      ({ record, process }) =>
        process.controls.notifyPeers(peerNoticeText(records.values(), record.view.id)).pipe(
          Effect.timeoutOption("1 second"),
          Effect.catch(() => Effect.void),
          Effect.asVoid,
        ),
      { concurrency: 8, discard: true },
    ).pipe(Effect.annotateLogs("changedRunId", changedId), Effect.asVoid);
  };

  const installProcess = (record: RunRecord) => {
    const scope = record.scope;
    return Effect.gen(function* () {
      yield* prepareBackendSpawn(record);
      const spawnSettled = yield* Deferred.make<void>();
      const spawnClaimed = yield* withLock(
        Effect.sync(() => {
          if (
            record.scope !== scope ||
            record.closingScope === scope ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped" ||
            record.backendSpawnAttempt !== undefined
          )
            return false;
          record.backendSpawnAttempt = { scope, settled: spawnSettled };
          return true;
        }),
      );
      if (!spawnClaimed)
        return yield* new InvalidSubagentRequestError({
          code: "start_cancelled",
          message: `Subagent ${record.view.id} was stopped before backend spawn.`,
        });
      const process = yield* record.driver.spawn(record.launch).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.ensuring(
          withLock(
            Effect.sync(() => {
              if (record.backendSpawnAttempt?.settled === spawnSettled)
                record.backendSpawnAttempt = undefined;
              Deferred.doneUnsafe(spawnSettled, Effect.void);
            }),
          ),
        ),
      );
      const attached = yield* withLock(
        Effect.sync(() => {
          if (
            record.scope !== scope ||
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            record.view.state === "stopped"
          )
            return false;
          record.process = process;
          record.view = (() => {
            const objectPart5222_0 = { ...record.view };
            const objectPart5222_1 =
              process.pid === undefined
                ? objectPart5222_0
                : { ...objectPart5222_0, pid: process.pid };
            return objectPart5222_1;
          })();
          publish();
          return true;
        }),
      );
      if (!attached)
        return yield* new InvalidSubagentRequestError({
          code: "start_cancelled",
          message: `Subagent ${record.view.id} was stopped during startup.`,
        });
      const isCurrentProcess = withLock(
        Effect.sync(() => record.scope === scope && record.process === process),
      );
      const eventConsumer = yield* Stream.fromQueue(process.events).pipe(
        Stream.runForEach((event) =>
          isCurrentProcess.pipe(
            Effect.flatMap((isCurrent) =>
              isCurrent
                ? handleBackendEvent(record, event).pipe(
                    Effect.catch((error) =>
                      failRun(record, error.message, error).pipe(Effect.asVoid),
                    ),
                  )
                : Effect.void,
            ),
            Effect.ensuring(Effect.sync(() => process.acknowledge(event))),
          ),
        ),
        Effect.catchCause(() => Effect.void),
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
                        Effect.andThen(handleBackendEvent(record, event)),
                      ),
                    ),
                  )
                : Effect.void,
            ),
          ),
        ),
        Effect.catch((error) => failRun(record, error.message).pipe(Effect.asVoid)),
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

  const initializeProcess = (record: RunRecord) =>
    installProcess(record).pipe(
      Effect.andThen(runControl(record, (process) => process.controls.initialize)),
    );

  return {
    initializeProcess,
    sendPeerNotices,
    startPrompt: (record: RunRecord, message: string, assignmentEpoch: number) =>
      runControl(record, (process) => process.controls.start(message, assignmentEpoch)),
    steer: (record: RunRecord, message: string) =>
      runControl(record, (process) => process.controls.steer(message)),
    interrupt: (record: RunRecord) => runControl(record, (process) => process.controls.interrupt),
    renameDisplay: (record: RunRecord, name: string) =>
      runControl(record, (process) => process.controls.renameDisplay(name)),
  };
}
