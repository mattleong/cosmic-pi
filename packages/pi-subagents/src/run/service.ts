import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { freezeSnapshot } from "pi-cosmic-core";
import { ChildProcess, type ChildLaunchRequest } from "../boundary/child-process.ts";
import type { SubagentNotification } from "../boundary/host-notifier.ts";
import type { ChildRateLimitEvent } from "./child-agent.ts";
import {
  InvalidSubagentRequestError,
  SubagentCapacityError,
  type SubagentError,
  SubagentNotFoundError,
  SubagentProcessError,
  SubagentProtocolError,
  SubagentRuntimeClosedError,
  SubagentWriterConflictError,
  UnsupportedSubagentCapabilityError,
} from "./errors.ts";
import { childSystemPrompt, peerNoticeText, taskPrompt } from "./coordination.ts";
import { makeRunEventHandler } from "./events.ts";
import type { RunRecord } from "./internal.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "./limits.ts";
import {
  CLAUDE_CLI_SUBAGENT_CAPABILITIES,
  emptyUsage,
  hasSubagentCapability,
  isActiveRunState,
  isClaudeModelSelector,
  PI_SUBAGENT_CAPABILITIES,
  type StartSubagentRequest,
  type SubagentCapability,
  type SubagentProjection,
  type SubagentRunView,
} from "./model.ts";
import {
  decodeRpcStateData,
  rpcStateModelId,
  type ParentReply,
  type RpcStateData,
  type PeerNotice,
  type RpcCommand,
  type RpcResponse,
} from "./protocol.ts";
import { sortRuns } from "./projection.ts";
import { appendNoticeSessionEvent } from "./session-output.ts";
import {
  MAX_ERROR_CHARS,
  MAX_TASK_CHARS,
  sanitizeDiagnosticText,
  sanitizeName,
  snapshotView,
} from "./state.ts";
import { appendTranscript } from "./transcript.ts";

const MAX_RUNS = 8;
const MAX_RETAINED = 50;
const RPC_TIMEOUT = "10 seconds";
const CLAUDE_INITIALIZATION_TIMEOUT = "60 seconds";
const CLAUDE_RATE_LIMIT_RESULT_GRACE = "2 seconds";
const CLAUDE_INITIALIZATION_RETRY_DELAY = "250 millis";
const RATE_LIMIT_NOTIFICATION_THRESHOLDS = [0.8, 0.9, 0.95] as const;

const isTerminalState = (state: SubagentRunView["state"]): boolean =>
  state === "completed" || state === "failed" || state === "stopped";

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || record.process !== undefined || record.view.state === "starting";

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

const rateLimitName = (value: string | undefined): string =>
  value ? value.replaceAll("_", " ") : "usage";

const rateLimitLabel = (value: string | undefined): string => `${rateLimitName(value)} limit`;

const rateLimitAllowance = (value: string | undefined): string =>
  `${rateLimitName(value)} allowance`;

const rateLimitResetText = (resetsAt: number | undefined, now: number): string => {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remainingMinutes = Math.max(0, Math.ceil((resetsAt * 1_000 - now) / 60_000));
  if (remainingMinutes < 60) return `; resets in ${remainingMinutes}m`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return `; resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
};

const rateLimitMessage = (event: ChildRateLimitEvent, now: number): string => {
  const utilization =
    event.utilization !== undefined && Number.isFinite(event.utilization)
      ? ` (${Math.max(0, Math.round(event.utilization * 100))}% used)`
      : "";
  const reset = rateLimitResetText(event.resetsAt, now);
  if (event.isUsingOverage)
    return `Claude exhausted its ${rateLimitAllowance(event.rateLimitType)}${utilization}${reset}; continuing with paid overage.`;
  if (
    event.status === "rejected" &&
    (event.overageStatus === "allowed" || event.overageStatus === "allowed_warning")
  )
    return `Claude exhausted its ${rateLimitAllowance(event.rateLimitType)}${utilization}${reset}; paid overage is available.`;
  const overageUnavailable =
    event.overageStatus === "rejected"
      ? `; paid overage unavailable${event.overageDisabledReason ? ` (${event.overageDisabledReason.replaceAll("_", " ")})` : ""}`
      : "";
  return event.status === "allowed_warning"
    ? `Claude is approaching its ${rateLimitLabel(event.rateLimitType)}${utilization}${reset}${overageUnavailable}.`
    : `Claude request was rejected by its ${rateLimitLabel(event.rateLimitType)}${utilization}${reset}${overageUnavailable}.`;
};

const validateParentMessage = (
  message: string,
  emptyMessage: string,
): Effect.Effect<string, InvalidSubagentRequestError> => {
  const normalized = message.trim();
  if (!normalized) return Effect.fail(new InvalidSubagentRequestError({ message: emptyMessage }));
  if (normalized.length > MAX_PARENT_MESSAGE_CHARS)
    return Effect.fail(
      new InvalidSubagentRequestError({
        message: `Subagent message exceeds ${MAX_PARENT_MESSAGE_CHARS} characters.`,
      }),
    );
  return Effect.succeed(normalized);
};

export interface SubagentServiceOptions {
  readonly publish?: (projection: SubagentProjection) => void;
  readonly notify?: (notification: SubagentNotification) => void;
}

export interface SubagentServiceShape {
  readonly start: (request: StartSubagentRequest) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly waitForForeground: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentRunView>>;
  readonly status: (id: string) => Effect.Effect<SubagentRunView, SubagentNotFoundError>;
  readonly send: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly reply: (id: string, message: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly interrupt: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly resume: (id: string, message?: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly rename: (id: string, name: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly stop: (id: string) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly projection: Effect.Effect<SubagentProjection>;
}

const protocolError = (message: string) => new SubagentProtocolError({ message });
const notFound = (id: string) =>
  new SubagentNotFoundError({ id, message: `Subagent run not found: ${id}` });
const capabilitiesFor = (request: StartSubagentRequest) =>
  request.backend === "claude-cli" ? CLAUDE_CLI_SUBAGENT_CAPABILITIES : PI_SUBAGENT_CAPABILITIES;
const requireCapability = (
  record: RunRecord,
  capability: SubagentCapability,
): Effect.Effect<void, UnsupportedSubagentCapabilityError> =>
  hasSubagentCapability(record.view, capability)
    ? Effect.void
    : Effect.fail(
        new UnsupportedSubagentCapabilityError({
          backend: record.view.backend,
          capability,
          message: `${record.view.backend} subagents do not support ${capability}.`,
        }),
      );

const makeService = Effect.fn("SubagentService.make")(function* (options: SubagentServiceOptions) {
  const childProcesses = yield* ChildProcess;
  const ownerScope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const records = new Map<string, RunRecord>();
  let nextRunId = 1;
  let revision = 0;
  let closed = false;

  const withLock = lock.withPermits(1);
  const currentProjection = (): SubagentProjection => ({
    revision,
    runs: sortRuns([...records.values()].map((record) => snapshotView(record.view))),
  });
  const publish = () => {
    revision += 1;
    try {
      options.publish?.(freezeSnapshot(currentProjection()));
    } catch {
      // Host projection delivery cannot own the fleet lifecycle.
    }
  };
  const notify = (notification: SubagentNotification) => {
    try {
      options.notify?.(notification);
    } catch {
      // Host transcript delivery is best effort.
    }
  };
  const requireRecord = (id: string): Effect.Effect<RunRecord, SubagentNotFoundError> =>
    Effect.suspend(() => {
      const record = records.get(id);
      return record ? Effect.succeed(record) : Effect.fail(notFound(id));
    });
  const mutateEventView = (
    record: RunRecord,
    update: (view: SubagentRunView) => SubagentRunView | undefined,
  ) =>
    withLock(
      Effect.sync(() => {
        if (
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          isTerminalState(record.view.state)
        )
          return undefined;
        const next = update(record.view);
        if (!next) return undefined;
        record.view = next;
        publish();
        return snapshotView(record.view);
      }),
    );
  const deliverForeground = (record: RunRecord, view: SubagentRunView): boolean => {
    if (!record.foregroundWaitPending) return false;
    record.foregroundWaitPending = false;
    Deferred.doneUnsafe(record.foregroundOutcome, Effect.succeed(view));
    return true;
  };
  const pauseFromEvent = (record: RunRecord, now: number) =>
    withLock(
      Effect.sync(() => {
        if (
          !record.pauseRequested ||
          record.stoppedByParent ||
          record.view.state === "stopping" ||
          isTerminalState(record.view.state)
        )
          return undefined;
        record.activeTools.clear();
        record.view = {
          ...record.view,
          state: "paused",
          lastActivityAt: now,
          question: undefined,
          currentTool: undefined,
        };
        const view = snapshotView(record.view);
        record.pauseRequested = false;
        const outcome = record.pauseOutcome;
        record.pauseOutcome = undefined;
        publish();
        if (outcome) Deferred.doneUnsafe(outcome, Effect.succeed(view));
        deliverForeground(record, view);
        return view;
      }),
    );
  const failPendingResponses = (record: RunRecord, error: SubagentError) => {
    for (const response of record.responses.values())
      Deferred.doneUnsafe(response, Effect.fail(error));
    record.responses.clear();
  };
  const markCleanupPending = (record: RunRecord) =>
    withLock(
      Effect.sync(() => {
        record.cleanupPending = true;
      }),
    );
  const clearCleanupPending = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    withLock(
      Effect.sync(() => {
        if (record.scope !== scope) return;
        record.cleanupPending = false;
        record.process = undefined;
        if (record.view.pid !== undefined) {
          const { pid: _pid, ...view } = record.view;
          record.view = view;
          publish();
        }
      }),
    );
  const closeRecordScope = (record: RunRecord, scope: Scope.Closeable = record.scope) =>
    Scope.close(scope, Exit.void).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        clearCleanupPending(record, scope).pipe(
          Effect.tap(() =>
            Exit.isFailure(exit)
              ? Effect.logWarning("Subagent scope cleanup failed; ownership was released.").pipe(
                  Effect.annotateLogs("runId", record.view.id),
                )
              : Effect.void,
          ),
        ),
      ),
    );
  const closeExitedScope = (record: RunRecord, scope: Scope.Closeable) =>
    closeRecordScope(record, scope).pipe(Effect.asVoid);

  const rpc = <A extends RpcCommand>(record: RunRecord, command: A) =>
    Effect.gen(function* () {
      const process = record.process;
      if (!process)
        return yield* new SubagentProcessError({
          operation: "send RPC command to",
          message: `Subagent ${record.view.id} has no active process.`,
        });
      const id = `${record.view.id}-rpc-${record.nextRpcId++}`;
      const response = yield* Deferred.make<RpcResponse, SubagentError>();
      record.responses.set(id, response);
      const timeout =
        record.view.backend === "claude-cli" && command.type === "get_state"
          ? CLAUDE_INITIALIZATION_TIMEOUT
          : RPC_TIMEOUT;
      const outcome = yield* process.send({ ...command, id }).pipe(
        Effect.andThen(Deferred.await(response)),
        Effect.timeoutOption(timeout),
        Effect.ensuring(
          Effect.sync(() => {
            record.responses.delete(id);
          }),
        ),
      );
      if (Option.isNone(outcome))
        return yield* new SubagentProcessError({
          operation: "await RPC response from",
          message: `Subagent ${record.view.id} did not answer ${command.type}.`,
        });
      if (!outcome.value.success)
        return yield* new SubagentProcessError({
          operation: `execute ${command.type} in`,
          message: sanitizeDiagnosticText(
            outcome.value.error ?? `Subagent RPC command ${command.type} failed.`,
            MAX_ERROR_CHARS,
          ),
        });
      return outcome.value;
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
      ({ record, process }) => {
        const message: PeerNotice = {
          channel: "pi-subagents",
          type: "peer_notice",
          message: peerNoticeText(records.values(), record.view.id),
        };
        return process.sendIpc(message).pipe(
          Effect.timeoutOption("1 second"),
          Effect.catch(() => Effect.void),
          Effect.asVoid,
        );
      },
      { concurrency: 8, discard: true },
    ).pipe(Effect.annotateLogs("changedRunId", changedId), Effect.asVoid);
  };

  const settle = (record: RunRecord, state: "completed" | "failed" | "stopped", error?: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const result = yield* withLock(
        Effect.sync(() => {
          if (
            isTerminalState(record.view.state) ||
            (state !== "stopped" && (record.stoppedByParent || record.view.state === "stopping"))
          )
            return { transitioned: false as const, view: snapshotView(record.view) };
          const settlement = record.settlement;
          const pauseOutcome = record.pauseOutcome;
          const completedScope =
            state === "completed" && record.process !== undefined ? record.scope : undefined;
          if (completedScope) record.cleanupPending = true;
          record.pauseOutcome = undefined;
          record.pauseRequested = false;
          record.activeTools.clear();
          record.view = {
            ...record.view,
            state,
            endedAt: now,
            lastActivityAt: now,
            currentTool: undefined,
            question: undefined,
            ...(state === "completed" && record.latestAssistantText
              ? { finalText: record.latestAssistantText }
              : {}),
            ...(error ? { error } : {}),
          };
          publish();
          return {
            transitioned: true as const,
            view: snapshotView(record.view),
            settlement,
            pauseOutcome,
            completedScope,
          };
        }),
      );
      const view = result.view;
      if (!result.transitioned) return view;
      Deferred.doneUnsafe(result.settlement, Effect.succeed(view));
      if (result.pauseOutcome) Deferred.doneUnsafe(result.pauseOutcome, Effect.succeed(view));
      const deliveredToForeground = deliverForeground(record, view);
      const evicted = yield* withLock(
        Effect.sync(() => {
          if (records.size <= MAX_RETAINED) return [] as RunRecord[];
          const candidates = [...records.values()]
            .filter(
              (candidate) =>
                candidate !== record &&
                !candidate.cleanupPending &&
                (candidate.view.state === "stopped" || candidate.view.state === "failed"),
            )
            .sort(
              (left, right) =>
                (left.view.endedAt ?? left.view.startedAt) -
                (right.view.endedAt ?? right.view.startedAt),
            );
          const removed: RunRecord[] = [];
          while (records.size > MAX_RETAINED && candidates.length > 0) {
            const candidate = candidates.shift();
            if (!candidate) break;
            records.delete(candidate.view.id);
            removed.push(candidate);
          }
          if (removed.length > 0) publish();
          return removed;
        }),
      );
      yield* Effect.forEach(evicted, (candidate) => Scope.close(candidate.scope, Exit.void), {
        concurrency: 8,
        discard: true,
      });
      if (!deliveredToForeground) {
        if (state === "completed")
          notify({
            type: "completed",
            id: view.id,
            name: view.name,
            ...(view.finalText ? { finalText: view.finalText } : {}),
          });
        else if (
          state === "failed" &&
          !(record.rateLimitRejected && record.rateLimitRejectionNotified)
        )
          notify({
            type: "warning",
            id: view.id,
            name: view.name,
            message: error ?? "Run failed.",
            triggerTurn: true,
          });
      }
      yield* sendPeerNotices(record.view.id);
      if (result.completedScope)
        yield* closeRecordScope(record, result.completedScope).pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
          Effect.asVoid,
        );
      return view;
    });

  const failRun = (record: RunRecord, message: string) =>
    markCleanupPending(record).pipe(
      Effect.andThen(
        record.process
          ? record.process.terminate("force").pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ),
      Effect.andThen(settle(record, "failed", sanitizeDiagnosticText(message, MAX_ERROR_CHARS))),
    );

  const handleRateLimit = (record: RunRecord, event: ChildRateLimitEvent) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const message = event.status === "allowed" ? undefined : rateLimitMessage(event, now);
      const rejected =
        event.status === "rejected" &&
        event.isUsingOverage !== true &&
        event.overageStatus === "rejected";
      const update = yield* withLock(
        Effect.sync(() => {
          const generation = ++record.rateLimitGeneration;
          record.rateLimitRejected = rejected;
          if (
            record.stoppedByParent ||
            record.view.state === "stopping" ||
            isTerminalState(record.view.state)
          )
            return { generation, notifyParent: false };

          const limitKey = event.rateLimitType ?? "usage";
          const previousNotice = record.rateLimitNotices.get(limitKey);
          const startsNewWindow =
            previousNotice !== undefined &&
            event.resetsAt !== undefined &&
            previousNotice.resetsAt !== event.resetsAt;
          const notice =
            previousNotice && !startsNewWindow
              ? previousNotice
              : {
                  ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
                  highestThreshold: 0,
                  overageNotified: false,
                  rejectionNotified: false,
                };
          let notifyParent = false;
          if (event.isUsingOverage) {
            notifyParent = !notice.overageNotified;
            notice.overageNotified = true;
          } else if (event.status === "rejected") {
            notifyParent = !notice.rejectionNotified;
            notice.rejectionNotified = true;
            if (notifyParent && rejected) record.rateLimitRejectionNotified = true;
          } else if (
            event.status === "allowed_warning" &&
            event.utilization !== undefined &&
            Number.isFinite(event.utilization)
          ) {
            const reached = RATE_LIMIT_NOTIFICATION_THRESHOLDS.filter(
              (threshold) => event.utilization !== undefined && event.utilization >= threshold,
            ).at(-1);
            if (reached !== undefined && reached > notice.highestThreshold) {
              notice.highestThreshold = reached;
              notifyParent = true;
            }
          }
          record.rateLimitNotices.set(limitKey, notice);

          if (!message) {
            if (record.rateLimitWarning && record.view.warning === record.rateLimitWarning) {
              record.view = { ...record.view, warning: undefined };
              publish();
            }
            record.rateLimitWarning = undefined;
            return { generation, notifyParent: false };
          }
          const duplicate = record.view.warning === message;
          record.rateLimitWarning = message;
          record.view = {
            ...record.view,
            warning: message,
            lastActivityAt: now,
            transcript:
              notifyParent && !duplicate
                ? appendTranscript(record.view.transcript, `warning: ${message}`)
                : record.view.transcript,
            sessionEvents:
              notifyParent && !duplicate
                ? appendNoticeSessionEvent(record.view.sessionEvents, "warning", message, now)
                : record.view.sessionEvents,
          };
          publish();
          return { generation, notifyParent };
        }),
      );
      if (event.status === "allowed" || !message) return;
      if (!rejected) {
        if (update.notifyParent)
          notify({
            type: "warning",
            id: record.view.id,
            name: record.view.name,
            message,
            triggerTurn: false,
          });
        return;
      }
      if (update.notifyParent) {
        notify({
          type: "warning",
          id: record.view.id,
          name: record.view.name,
          message,
          triggerTurn: true,
        });
      }
      yield* Effect.sleep(CLAUDE_RATE_LIMIT_RESULT_GRACE).pipe(
        Effect.andThen(
          withLock(
            Effect.sync(
              () =>
                record.rateLimitGeneration === update.generation &&
                !record.stoppedByParent &&
                record.view.state !== "stopping" &&
                !isTerminalState(record.view.state),
            ),
          ),
        ),
        Effect.flatMap((stillRejected) =>
          stillRejected ? failRun(record, message).pipe(Effect.asVoid) : Effect.void,
        ),
        Effect.forkIn(record.scope, { startImmediately: true }),
        Effect.asVoid,
      );
    });

  const handleWireEvent = makeRunEventHandler({
    mutateView: mutateEventView,
    settle,
    notify,
    failPendingResponses,
    failRun,
    deliverForeground,
    pauseFromEvent,
    handleRateLimit,
  });

  const installProcess = (record: RunRecord) => {
    const scope = record.scope;
    return Effect.gen(function* () {
      const process = yield* childProcesses
        .spawn(record.launch)
        .pipe(Effect.provideService(Scope.Scope, scope));
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
          record.view = { ...record.view, pid: process.pid };
          publish();
          return true;
        }),
      );
      if (!attached)
        return yield* new InvalidSubagentRequestError({
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
                ? handleWireEvent(record, event).pipe(
                    Effect.catch((error) => {
                      failPendingResponses(record, error);
                      return failRun(record, error.message).pipe(Effect.asVoid);
                    }),
                  )
                : Effect.void,
            ),
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
                        Effect.andThen(handleWireEvent(record, event)),
                      ),
                    ),
                  )
                : Effect.void,
            ),
            Effect.ensuring(
              closeExitedScope(record, scope).pipe(
                Effect.forkIn(ownerScope, { startImmediately: true }),
                Effect.asVoid,
              ),
            ),
          ),
        ),
        Effect.catch((error) => failRun(record, error.message).pipe(Effect.asVoid)),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      return process;
    });
  };

  const isRetryableClaudeInitialization = (error: SubagentError): boolean =>
    error._tag === "SubagentProcessError" &&
    (error.operation === "spawn" ||
      error.operation === "await RPC response from" ||
      error.operation === "initialize stream");

  const prepareInitializationRetry = (record: RunRecord) =>
    Effect.gen(function* () {
      const priorScope = record.scope;
      yield* markCleanupPending(record);
      yield* closeRecordScope(record, priorScope);
      yield* Effect.sleep(CLAUDE_INITIALIZATION_RETRY_DELAY);
      const nextScope = yield* Scope.fork(ownerScope);
      const accepted = yield* withLock(
        Effect.sync(() => {
          if (
            record.stoppedByParent ||
            record.view.state !== "starting" ||
            record.scope !== priorScope
          )
            return false;
          record.scope = nextScope;
          record.cleanupPending = false;
          record.process = undefined;
          return true;
        }),
      );
      if (!accepted) {
        yield* Scope.close(nextScope, Exit.void);
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${record.view.id} stopped before initialization retry.`,
        });
      }
    });

  const initializeProcess: (
    record: RunRecord,
    retriesRemaining: number,
    claudeBootstrapPrompt: string | undefined,
  ) => Effect.Effect<RpcStateData, SubagentError> = (
    record,
    retriesRemaining,
    claudeBootstrapPrompt,
  ) =>
    Effect.gen(function* () {
      yield* installProcess(record);
      if (record.view.backend === "claude-cli") {
        if (claudeBootstrapPrompt === undefined)
          return yield* protocolError("Claude startup requires an initial prompt.");
        yield* rpc(record, { type: "prompt", message: claudeBootstrapPrompt });
      }
      const stateResponse = yield* rpc(record, { type: "get_state" });
      return yield* decodeRpcStateData(stateResponse.data).pipe(
        Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
      );
    }).pipe(
      Effect.catch((error) =>
        record.view.backend === "claude-cli" &&
        retriesRemaining > 0 &&
        isRetryableClaudeInitialization(error)
          ? prepareInitializationRetry(record).pipe(
              Effect.andThen(
                initializeProcess(record, retriesRemaining - 1, claudeBootstrapPrompt),
              ),
            )
          : Effect.fail(error),
      ),
    );

  const start: SubagentServiceShape["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request.task.trim())
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is required." });
        if (request.backend === "claude-cli" && !request.projectTrusted)
          return yield* new InvalidSubagentRequestError({
            message: "Claude CLI subagents require a trusted project.",
          });
        if (request.backend === "claude-cli" && request.context === "fork")
          return yield* new InvalidSubagentRequestError({
            message: "Claude CLI does not support forked Pi context yet.",
          });
        if (request.backend === "claude-cli" && !isClaudeModelSelector(request.model))
          return yield* new InvalidSubagentRequestError({
            message: "Claude model must be an alias or full model ID of at most 128 characters.",
          });
        if (
          request.backend === "claude-cli" &&
          request.effortWasExplicit &&
          (request.effort === "off" || request.effort === "minimal")
        )
          return yield* new InvalidSubagentRequestError({
            message: `Claude CLI does not support effort ${request.effort}.`,
          });
        if (request.task.length > MAX_TASK_CHARS)
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is too large." });
        const name = sanitizeName(request.name ?? "") || `subagent-${nextRunId}`;
        const now = yield* Clock.currentTimeMillis;
        const scope = yield* Scope.fork(ownerScope);
        const settlement = yield* Deferred.make<SubagentRunView>();
        const foregroundOutcome = yield* Deferred.make<SubagentRunView>();
        const reserved = yield* withLock(
          Effect.gen(function* () {
            if (closed)
              return yield* new SubagentRuntimeClosedError({
                message: "The subagent session runtime is closed.",
              });
            const retainedProcesses = [...records.values()].filter(ownsProcessSlot).length;
            if (retainedProcesses >= MAX_RUNS)
              return yield* new SubagentCapacityError({
                limit: MAX_RUNS,
                message: `Subagent capacity reached (${MAX_RUNS}). Stop an existing run first.`,
              });
            if (request.writeIntent === "writer") {
              const activeWriter = [...records.values()].find(ownsWriterSlot);
              if (activeWriter)
                return yield* new SubagentWriterConflictError({
                  activeId: activeWriter.view.id,
                  activeName: activeWriter.view.name,
                  message: `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
                });
            }
            const id = `agent-${nextRunId++}`;
            const view: SubagentRunView = {
              id,
              name,
              task: request.task.trim(),
              cwd: request.cwd,
              state: "starting",
              execution: request.execution,
              context: request.context,
              writeIntent: request.writeIntent,
              backend: request.backend,
              capabilities: capabilitiesFor(request),
              model: request.model,
              effort: request.effort,
              startedAt: now,
              lastActivityAt: now,
              transcript: [],
              sessionEvents: [],
              usage: emptyUsage(),
            };
            const launch: ChildLaunchRequest = {
              runId: id,
              name,
              backend: request.backend,
              cwd: request.cwd,
              context: request.context,
              writeIntent: request.writeIntent,
              model: request.model,
              effort: request.effort,
              ...(request.runtimeApiKey ? { runtimeApiKey: request.runtimeApiKey } : {}),
              activeTools: request.activeTools,
              projectTrusted: request.projectTrusted,
              parentSessionId: request.parentSessionId,
              ...(request.parentSessionFile
                ? { parentSessionFile: request.parentSessionFile }
                : {}),
              ...(request.parentLeafId ? { parentLeafId: request.parentLeafId } : {}),
              systemPrompt: childSystemPrompt(request),
            };
            const record: RunRecord = {
              view,
              scope,
              launch,
              responses: new Map(),
              activeTools: new Map(),
              nextRpcId: 1,
              settlement,
              foregroundOutcome,
              foregroundWaitPending: request.execution === "foreground",
              pauseRequested: false,
              stoppedByParent: false,
              cleanupPending: false,
              progressTurnTriggered: false,
              warningTurnTriggered: false,
              rateLimitGeneration: 0,
              rateLimitRejected: false,
              rateLimitRejectionNotified: false,
              rateLimitNotices: new Map(),
            };
            records.set(id, record);
            publish();
            return record;
          }),
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));

        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const state = yield* initializeProcess(
            reserved,
            1,
            request.backend === "claude-cli" ? initialPrompt : undefined,
          );
          if (
            request.backend === "pi" &&
            request.effortWasExplicit &&
            state.thinkingLevel !== request.effort
          )
            return yield* new InvalidSubagentRequestError({
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.thinkingLevel}.`,
            });
          const resolvedModel = rpcStateModelId(state.model) ?? reserved.view.model;
          const startedAt = yield* Clock.currentTimeMillis;
          const activated = yield* withLock(
            Effect.sync(() => {
              if (
                reserved.stoppedByParent ||
                reserved.view.state === "stopping" ||
                reserved.view.state === "stopped"
              )
                return undefined;
              if (isTerminalState(reserved.view.state)) {
                reserved.view = {
                  ...reserved.view,
                  effort: state.thinkingLevel as StartSubagentRequest["effort"],
                  model: resolvedModel,
                  sessionId: state.sessionId,
                  ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                };
                publish();
                return snapshotView(reserved.view);
              }
              reserved.view = {
                ...reserved.view,
                state: "running",
                effort: state.thinkingLevel as StartSubagentRequest["effort"],
                model: resolvedModel,
                lastActivityAt: startedAt,
                sessionId: state.sessionId,
                ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
              };
              publish();
              return snapshotView(reserved.view);
            }),
          );
          if (!activated)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${reserved.view.id} was stopped during startup.`,
            });
          if (request.backend === "pi")
            yield* rpc(reserved, { type: "prompt", message: initialPrompt });
          yield* sendPeerNotices(reserved.view.id);
          return activated;
        });

        return yield* restore(initialize).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const message = sanitizeDiagnosticText(Cause.pretty(cause), MAX_ERROR_CHARS);
              yield* markCleanupPending(reserved);
              if (!reserved.stoppedByParent) yield* settle(reserved, "failed", message);
              yield* closeRecordScope(reserved);
            }),
          ),
        );
      }),
    );

  const waitForForeground: SubagentServiceShape["waitForForeground"] = (id) =>
    Effect.flatMap(requireRecord(id), (record) =>
      Deferred.await(record.foregroundOutcome).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            record.foregroundWaitPending = false;
          }),
        ),
      ),
    );
  const list = withLock(
    Effect.sync(() => sortRuns([...records.values()].map((record) => snapshotView(record.view)))),
  );
  const status: SubagentServiceShape["status"] = (id) =>
    withLock(
      Effect.flatMap(requireRecord(id), (record) => Effect.succeed(snapshotView(record.view))),
    );

  const send: SubagentServiceShape["send"] = (id, message) =>
    Effect.gen(function* () {
      const normalized = yield* validateParentMessage(message, "Guidance message is required.");
      const record = yield* withLock(
        Effect.gen(function* () {
          const selected = yield* requireRecord(id);
          yield* requireCapability(selected, "steer");
          if (selected.view.state === "waiting_for_parent")
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} is waiting for a reply; use action=reply.`,
            });
          if (selected.replyPendingRequestId)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} already has a parent reply in flight.`,
            });
          if (selected.view.state !== "running")
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} is ${selected.view.state}; use action=resume.`,
            });
          return selected;
        }),
      );
      yield* rpc(record, { type: "steer", message: normalized });
      const now = yield* Clock.currentTimeMillis;
      return yield* withLock(
        Effect.gen(function* () {
          if (record.view.state !== "running")
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} stopped before guidance was recorded.`,
            });
          if (record.replyPendingRequestId)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} claimed a parent reply before guidance was recorded.`,
            });
          record.view = {
            ...record.view,
            lastActivityAt: now,
            transcript: appendTranscript(record.view.transcript, `parent guidance: ${normalized}`),
            sessionEvents: appendNoticeSessionEvent(
              record.view.sessionEvents,
              "parent",
              `Guidance: ${normalized}`,
              now,
            ),
          };
          publish();
          return snapshotView(record.view);
        }),
      );
    });

  const reply: SubagentServiceShape["reply"] = (id, message) =>
    Effect.gen(function* () {
      const normalized = yield* validateParentMessage(message, "Reply message is required.");
      const claimed = yield* withLock(
        Effect.gen(function* () {
          const record = yield* requireRecord(id);
          yield* requireCapability(record, "parent-contact");
          const question = record.view.question;
          if (record.view.state !== "waiting_for_parent" || !question)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} has no pending parent question.`,
            });
          if (record.replyPendingRequestId)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} already has a reply in flight.`,
            });
          const process = record.process;
          if (!process)
            return yield* new SubagentProcessError({
              operation: "reply to",
              message: `Subagent ${id} has no active process.`,
            });
          record.replyPendingRequestId = question.requestId;
          record.view = { ...record.view, state: "running", question: undefined };
          publish();
          return { record, process, question };
        }),
      );
      const envelope: ParentReply = {
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: claimed.question.requestId,
        message: normalized,
      };
      return yield* claimed.process.sendIpc(envelope).pipe(
        Effect.andThen(Clock.currentTimeMillis),
        Effect.flatMap((now) =>
          withLock(
            Effect.sync(() => {
              if (claimed.record.replyPendingRequestId === claimed.question.requestId)
                claimed.record.replyPendingRequestId = undefined;
              claimed.record.view = {
                ...claimed.record.view,
                lastActivityAt: now,
                transcript: appendTranscript(
                  claimed.record.view.transcript,
                  `parent reply: ${normalized}`,
                ),
                sessionEvents: appendNoticeSessionEvent(
                  claimed.record.view.sessionEvents,
                  "parent",
                  `Reply: ${normalized}`,
                  now,
                ),
              };
              publish();
              return snapshotView(claimed.record.view);
            }),
          ),
        ),
        Effect.onError(() =>
          withLock(
            Effect.sync(() => {
              if (claimed.record.replyPendingRequestId !== claimed.question.requestId) return;
              claimed.record.replyPendingRequestId = undefined;
              if (
                claimed.record.view.state === "running" &&
                claimed.record.view.question === undefined
              ) {
                claimed.record.view = {
                  ...claimed.record.view,
                  state: "waiting_for_parent",
                  question: claimed.question,
                };
                publish();
              }
            }),
          ),
        ),
      );
    });

  const interrupt: SubagentServiceShape["interrupt"] = (id) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const pauseOutcome = yield* Deferred.make<SubagentRunView, SubagentError>();
        const record = yield* withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            yield* requireCapability(selected, "interrupt");
            if (selected.view.state !== "running" && selected.view.state !== "waiting_for_parent")
              return yield* new InvalidSubagentRequestError({
                message: `Subagent ${id} cannot be interrupted while ${selected.view.state}.`,
              });
            if (selected.pauseRequested)
              return yield* new InvalidSubagentRequestError({
                message: `Subagent ${id} already has an interrupt pending.`,
              });
            selected.pauseRequested = true;
            selected.pauseOutcome = pauseOutcome;
            return selected;
          }),
        );
        const commit = Effect.gen(function* () {
          yield* Effect.raceFirst(
            rpc(record, { type: "abort" }).pipe(Effect.asVoid),
            Deferred.await(pauseOutcome).pipe(Effect.asVoid),
          ).pipe(
            Effect.catch((error) =>
              withLock(
                Effect.gen(function* () {
                  if (record.view.state === "paused") return;
                  const responseTimedOut =
                    error._tag === "SubagentProcessError" &&
                    error.operation === "await RPC response from";
                  if (!responseTimedOut && record.pauseOutcome === pauseOutcome) {
                    record.pauseRequested = false;
                    record.pauseOutcome = undefined;
                  }
                  return yield* error;
                }),
              ),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          return yield* withLock(
            Effect.gen(function* () {
              if (record.view.state === "paused") return snapshotView(record.view);
              if (record.view.state !== "running" && record.view.state !== "waiting_for_parent")
                return yield* new InvalidSubagentRequestError({
                  message: `Subagent ${id} stopped before interruption completed.`,
                });
              record.pauseRequested = false;
              if (record.pauseOutcome === pauseOutcome) record.pauseOutcome = undefined;
              record.activeTools.clear();
              record.view = {
                ...record.view,
                state: "paused",
                question: undefined,
                currentTool: undefined,
                lastActivityAt: now,
              };
              const view = snapshotView(record.view);
              publish();
              deliverForeground(record, view);
              return view;
            }),
          );
        });
        const commitFiber = yield* commit.pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Fiber.join(commitFiber));
      }),
    );

  const waitForRunCleanup: (id: string) => Effect.Effect<void, SubagentNotFoundError> = (id) =>
    withLock(
      Effect.gen(function* () {
        const record = yield* requireRecord(id);
        return record.cleanupPending;
      }),
    ).pipe(
      Effect.flatMap((cleanupPending) =>
        cleanupPending
          ? Effect.sleep("25 millis").pipe(Effect.andThen(waitForRunCleanup(id)))
          : Effect.void,
      ),
    );

  const resume: SubagentServiceShape["resume"] = (id, message) =>
    waitForRunCleanup(id).pipe(
      Effect.andThen(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const prompt = message?.trim()
              ? yield* validateParentMessage(message, "Resume message is required.")
              : "Continue the assigned task from the current session state.";
            const nextSettlement = yield* Deferred.make<SubagentRunView>();
            const now = yield* Clock.currentTimeMillis;
            const claimed = yield* withLock(
              Effect.gen(function* () {
                const selected = yield* requireRecord(id);
                yield* requireCapability(selected, "resume");
                if (selected.view.state !== "paused" && selected.view.state !== "completed")
                  return yield* new InvalidSubagentRequestError({
                    message: `Subagent ${id} cannot resume while ${selected.view.state}.`,
                  });
                if (selected.view.writeIntent === "writer") {
                  const activeWriter = [...records.values()].find(
                    (candidate) => candidate !== selected && ownsWriterSlot(candidate),
                  );
                  if (activeWriter)
                    return yield* new SubagentWriterConflictError({
                      activeId: activeWriter.view.id,
                      activeName: activeWriter.view.name,
                      message: `Writer ${activeWriter.view.name} (${activeWriter.view.id}) already owns the shared cwd.`,
                    });
                }
                const needsRespawn = selected.process === undefined;
                if (needsRespawn) {
                  const retainedProcesses = [...records.values()].filter(
                    (candidate) => candidate !== selected && ownsProcessSlot(candidate),
                  ).length;
                  if (retainedProcesses >= MAX_RUNS)
                    return yield* new SubagentCapacityError({
                      limit: MAX_RUNS,
                      message: `Subagent capacity reached (${MAX_RUNS}). Stop an existing run first.`,
                    });
                  if (selected.view.backend === "pi" && !selected.view.sessionFile)
                    return yield* new InvalidSubagentRequestError({
                      message: `Subagent ${id} cannot resume because its Pi session file is unavailable.`,
                    });
                  if (selected.view.backend === "claude-cli" && !selected.view.sessionId)
                    return yield* new InvalidSubagentRequestError({
                      message: `Subagent ${id} cannot resume because its Claude session ID is unavailable.`,
                    });
                }
                selected.settlement = nextSettlement;
                selected.pauseRequested = false;
                selected.pauseOutcome = undefined;
                selected.activeTools.clear();
                selected.progressTurnTriggered = false;
                selected.warningTurnTriggered = false;
                selected.view = {
                  ...selected.view,
                  state: "starting",
                  question: undefined,
                  currentTool: undefined,
                  lastActivityAt: now,
                };
                publish();
                return { record: selected, needsRespawn };
              }),
            );
            const commit = Effect.gen(function* () {
              const record = claimed.record;
              let promptSubmittedDuringInitialization = false;
              if (claimed.needsRespawn) {
                const nextScope = yield* Scope.fork(ownerScope);
                const installed = yield* withLock(
                  Effect.sync(() => {
                    if (
                      record.stoppedByParent ||
                      record.view.state !== "starting" ||
                      record.process !== undefined
                    )
                      return false;
                    record.scope = nextScope;
                    record.cleanupPending = false;
                    record.launch = {
                      ...record.launch,
                      ...(record.view.backend === "pi"
                        ? {
                            resumeSessionFile: record.view.sessionFile,
                            resumeSessionId: undefined,
                          }
                        : {
                            resumeSessionFile: undefined,
                            resumeSessionId: record.view.sessionId,
                          }),
                    };
                    return true;
                  }),
                );
                if (!installed) {
                  yield* Scope.close(nextScope, Exit.void);
                  return yield* new InvalidSubagentRequestError({
                    message: `Subagent ${id} stopped before its session could be restored.`,
                  });
                }
                const claudeBootstrapPrompt =
                  record.view.backend === "claude-cli" ? prompt : undefined;
                const state = yield* initializeProcess(record, 1, claudeBootstrapPrompt);
                promptSubmittedDuringInitialization = claudeBootstrapPrompt !== undefined;
                const resolvedModel = rpcStateModelId(state.model) ?? record.view.model;
                yield* withLock(
                  Effect.sync(() => {
                    if (record.view.state !== "starting") return;
                    record.view = {
                      ...record.view,
                      model: resolvedModel,
                      effort: state.thinkingLevel as StartSubagentRequest["effort"],
                      sessionId: state.sessionId,
                      ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
                    };
                    publish();
                  }),
                );
              }
              if (!promptSubmittedDuringInitialization)
                yield* rpc(claimed.record, { type: "prompt", message: prompt });
              const view = yield* withLock(
                Effect.sync(() => {
                  const record = claimed.record;
                  if (record.view.state !== "starting") return snapshotView(record.view);
                  record.latestAssistantText = undefined;
                  record.view = {
                    ...record.view,
                    state: "running",
                    endedAt: undefined,
                    error: undefined,
                    finalText: undefined,
                    lastActivityAt: now,
                    transcript: appendTranscript(
                      record.view.transcript,
                      `parent resumed: ${prompt}`,
                    ),
                    sessionEvents: appendNoticeSessionEvent(
                      record.view.sessionEvents,
                      "parent",
                      `Resume: ${prompt}`,
                      now,
                    ),
                  };
                  publish();
                  return snapshotView(record.view);
                }),
              );
              if (view.state !== "running")
                return yield* new SubagentProcessError({
                  operation: "resume",
                  message: view.error ?? `Subagent ${id} stopped before resume completed.`,
                });
              yield* sendPeerNotices(id);
              return view;
            }).pipe(
              Effect.onError((cause) =>
                failRun(claimed.record, Cause.pretty(cause)).pipe(
                  Effect.andThen(closeRecordScope(claimed.record)),
                  Effect.asVoid,
                ),
              ),
            );
            const commitFiber = yield* commit.pipe(
              Effect.forkIn(ownerScope, { startImmediately: true }),
            );
            return yield* restore(Fiber.join(commitFiber));
          }),
        ),
      ),
    );

  const rename: SubagentServiceShape["rename"] = (id, rawName) =>
    Effect.gen(function* () {
      const name = sanitizeName(rawName);
      if (!name)
        return yield* new InvalidSubagentRequestError({ message: "Subagent name is required." });
      const record = yield* requireRecord(id);
      yield* requireCapability(record, "rename-display");
      if (
        record.view.state === "starting" ||
        record.view.state === "stopping" ||
        record.view.state === "stopped" ||
        record.view.state === "failed"
      )
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${id} cannot be renamed while ${record.view.state}.`,
        });
      if (record.view.backend === "pi") yield* rpc(record, { type: "set_session_name", name });
      const view = yield* withLock(
        Effect.gen(function* () {
          if (record.view.state === "stopping" || isTerminalState(record.view.state))
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} stopped before rename completed.`,
            });
          record.view = { ...record.view, name };
          publish();
          return snapshotView(record.view);
        }),
      );
      yield* sendPeerNotices(id);
      return view;
    });

  const stop: SubagentServiceShape["stop"] = (id) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const record = yield* withLock(
          Effect.gen(function* () {
            const selected = yield* requireRecord(id);
            if (selected.view.state === "stopped") return selected;
            selected.stoppedByParent = true;
            selected.cleanupPending = true;
            selected.activeTools.clear();
            selected.view = {
              ...selected.view,
              state: "stopping",
              question: undefined,
              currentTool: undefined,
            };
            publish();
            return selected;
          }),
        );
        if (record.view.state === "stopped") return snapshotView(record.view);
        failPendingResponses(
          record,
          new SubagentProcessError({ operation: "stop", message: `Subagent ${id} was stopped.` }),
        );
        const cleanup = closeRecordScope(record).pipe(Effect.andThen(settle(record, "stopped")));
        const cleanupFiber = yield* cleanup.pipe(
          Effect.forkIn(ownerScope, { startImmediately: true }),
        );
        return yield* restore(Fiber.join(cleanupFiber));
      }),
    );

  const projection = withLock(Effect.sync(() => freezeSnapshot(currentProjection())));

  const service: SubagentServiceShape = {
    start,
    waitForForeground,
    list,
    status,
    send,
    reply,
    interrupt,
    resume,
    rename,
    stop,
    projection,
  };

  yield* Effect.addFinalizer(() =>
    withLock(
      Effect.sync(() => {
        closed = true;
      }),
    ).pipe(
      Effect.andThen(
        Effect.forEach(
          [...records.values()],
          (record) => {
            record.stoppedByParent = true;
            failPendingResponses(
              record,
              new SubagentRuntimeClosedError({ message: "Parent session shut down." }),
            );
            return Scope.close(record.scope, Exit.void);
          },
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.asVoid,
    ),
  );

  return service;
});

export class SubagentService extends Context.Service<SubagentService, SubagentServiceShape>()(
  "pi-subagents/run/service/SubagentService",
) {
  static readonly layer = (options: SubagentServiceOptions = {}) =>
    Layer.effect(this, makeService(options));

  static override readonly use = <A, E>(
    f: (service: SubagentServiceShape) => Effect.Effect<A, E>,
  ) => Effect.flatMap(this, f);
}
