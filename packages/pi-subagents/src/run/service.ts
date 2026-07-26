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
  type ParentReply,
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

const isTerminalState = (state: SubagentRunView["state"]): boolean =>
  state === "completed" || state === "failed" || state === "stopped";

const ownsProcessSlot = (record: RunRecord): boolean =>
  record.cleanupPending || (record.view.state !== "stopped" && record.view.state !== "failed");

const ownsWriterSlot = (record: RunRecord): boolean =>
  record.view.writeIntent === "writer" &&
  (record.cleanupPending || isActiveRunState(record.view.state));

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
  const clearCleanupPending = (record: RunRecord) =>
    withLock(
      Effect.sync(() => {
        record.cleanupPending = false;
        record.process = undefined;
      }),
    );
  const closeExitedScope = (record: RunRecord) =>
    Scope.close(record.scope, Exit.void).pipe(
      Effect.ensuring(clearCleanupPending(record)),
      Effect.asVoid,
    );

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
        else if (state === "failed")
          notify({
            type: "warning",
            id: view.id,
            name: view.name,
            message: error ?? "Run failed.",
            triggerTurn: true,
          });
      }
      yield* sendPeerNotices(record.view.id);
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

  const handleWireEvent = makeRunEventHandler({
    mutateView: mutateEventView,
    settle,
    notify,
    failPendingResponses,
    failRun,
    deliverForeground,
    pauseFromEvent,
  });

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
            const record: RunRecord = {
              view,
              scope,
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
            };
            records.set(id, record);
            publish();
            return record;
          }),
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));

        const peerNotice = peerNoticeText(records.values(), reserved.view.id);
        const launch: ChildLaunchRequest = {
          runId: reserved.view.id,
          name: reserved.view.name,
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
          ...(request.parentSessionFile ? { parentSessionFile: request.parentSessionFile } : {}),
          ...(request.parentLeafId ? { parentLeafId: request.parentLeafId } : {}),
          systemPrompt: childSystemPrompt(request),
        };

        const initialPrompt = taskPrompt(request, peerNotice);
        const initialize = Effect.gen(function* () {
          const process = yield* childProcesses
            .spawn(launch)
            .pipe(Effect.provideService(Scope.Scope, scope));
          const attached = yield* withLock(
            Effect.sync(() => {
              if (
                reserved.stoppedByParent ||
                reserved.view.state === "stopping" ||
                reserved.view.state === "stopped"
              )
                return false;
              reserved.process = process;
              reserved.view = { ...reserved.view, pid: process.pid };
              publish();
              return true;
            }),
          );
          if (!attached)
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${reserved.view.id} was stopped during startup.`,
            });
          const eventConsumer = yield* Stream.fromQueue(process.events).pipe(
            Stream.runForEach((event) =>
              handleWireEvent(reserved, event).pipe(
                Effect.catch((error) => {
                  failPendingResponses(reserved, error);
                  return failRun(reserved, error.message).pipe(Effect.asVoid);
                }),
              ),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          yield* process.awaitExit.pipe(
            Effect.flatMap((event) =>
              markCleanupPending(reserved).pipe(
                Effect.andThen(
                  Fiber.join(eventConsumer).pipe(Effect.andThen(handleWireEvent(reserved, event))),
                ),
                Effect.ensuring(
                  closeExitedScope(reserved).pipe(
                    Effect.forkIn(ownerScope, { startImmediately: true }),
                    Effect.asVoid,
                  ),
                ),
              ),
            ),
            Effect.catch((error) => failRun(reserved, error.message).pipe(Effect.asVoid)),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          if (request.backend === "claude-cli")
            yield* rpc(reserved, { type: "prompt", message: initialPrompt });
          const stateResponse = yield* rpc(reserved, { type: "get_state" });
          const state = yield* decodeRpcStateData(stateResponse.data).pipe(
            Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
          );
          if (
            request.backend === "pi" &&
            request.effortWasExplicit &&
            state.thinkingLevel !== request.effort
          )
            return yield* new InvalidSubagentRequestError({
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.thinkingLevel}.`,
            });
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
                  model: state.model ?? reserved.view.model,
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
                model: state.model ?? reserved.view.model,
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
              yield* Scope.close(scope, Exit.void).pipe(
                Effect.andThen(clearCleanupPending(reserved)),
              );
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
      const view = yield* withLock(
        Effect.gen(function* () {
          if (record.view.state === "paused") return snapshotView(record.view);
          if (record.view.state !== "running" && record.view.state !== "waiting_for_parent")
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} stopped before interruption completed.`,
            });
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
      return view;
    });

  const resume: SubagentServiceShape["resume"] = (id, message) =>
    Effect.gen(function* () {
      const prompt = message?.trim()
        ? yield* validateParentMessage(message, "Resume message is required.")
        : "Continue the assigned task from the current session state.";
      const nextSettlement = yield* Deferred.make<SubagentRunView>();
      const now = yield* Clock.currentTimeMillis;
      const record = yield* withLock(
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
          return selected;
        }),
      );
      yield* rpc(record, { type: "prompt", message: prompt }).pipe(
        Effect.onError((cause) => failRun(record, Cause.pretty(cause)).pipe(Effect.asVoid)),
      );
      const view = yield* withLock(
        Effect.sync(() => {
          if (record.view.state !== "starting") return snapshotView(record.view);
          record.latestAssistantText = undefined;
          record.view = {
            ...record.view,
            state: "running",
            endedAt: undefined,
            error: undefined,
            finalText: undefined,
            lastActivityAt: now,
            transcript: appendTranscript(record.view.transcript, `parent resumed: ${prompt}`),
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
    });

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
        const cleanup = Scope.close(record.scope, Exit.void).pipe(
          Effect.andThen(clearCleanupPending(record)),
          Effect.andThen(settle(record, "stopped")),
        );
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
