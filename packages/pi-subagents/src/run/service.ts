import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
} from "./errors.ts";
import { childSystemPrompt, peerNoticeText, taskPrompt } from "./coordination.ts";
import { makeRunEventHandler } from "./events.ts";
import type { RunRecord } from "./internal.ts";
import {
  emptyUsage,
  isActiveRunState,
  type StartSubagentRequest,
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
  const mutateView = (record: RunRecord, update: (view: SubagentRunView) => SubagentRunView) =>
    withLock(
      Effect.sync(() => {
        record.view = update(record.view);
        publish();
        return snapshotView(record.view);
      }),
    );
  const failPendingResponses = (record: RunRecord, error: SubagentError) => {
    for (const response of record.responses.values())
      Deferred.doneUnsafe(response, Effect.fail(error));
    record.responses.clear();
  };

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
      yield* process.send({ ...command, id }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            record.responses.delete(id);
          }),
        ),
      );
      const outcome = yield* Deferred.await(response).pipe(Effect.timeoutOption(RPC_TIMEOUT));
      record.responses.delete(id);
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

  const sendPeerNotices = (changedId: string) =>
    Effect.forEach(
      [...records.values()].filter(
        (record) => record.process && isActiveRunState(record.view.state),
      ),
      (record) => {
        const message: PeerNotice = {
          channel: "pi-subagents",
          type: "peer_notice",
          message: peerNoticeText(records.values(), record.view.id),
        };
        return record.process!.sendIpc(message).pipe(Effect.catch(() => Effect.void));
      },
      { concurrency: 8, discard: true },
    ).pipe(Effect.annotateLogs("changedRunId", changedId), Effect.asVoid);

  const settle = (record: RunRecord, state: "completed" | "failed" | "stopped", error?: string) =>
    Effect.gen(function* () {
      if (record.view.state === state && record.view.endedAt !== undefined)
        return snapshotView(record.view);
      const now = yield* Clock.currentTimeMillis;
      const view = yield* mutateView(record, (current) => ({
        ...current,
        state,
        endedAt: now,
        lastActivityAt: now,
        currentTool: undefined,
        question: undefined,
        ...(error ? { error } : {}),
      }));
      Deferred.doneUnsafe(record.settlement, Effect.succeed(view));
      Deferred.doneUnsafe(record.foregroundOutcome, Effect.succeed(view));
      const evicted = yield* withLock(
        Effect.sync(() => {
          if (records.size <= MAX_RETAINED) return [] as RunRecord[];
          const candidates = [...records.values()]
            .filter(
              (candidate) =>
                candidate !== record &&
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
      if (record.view.execution === "background") {
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
          });
      }
      yield* sendPeerNotices(record.view.id);
      return view;
    });

  const failRun = (record: RunRecord, message: string) =>
    (record.process
      ? record.process.terminate("force").pipe(Effect.catch(() => Effect.void))
      : Effect.void
    ).pipe(
      Effect.andThen(settle(record, "failed", sanitizeDiagnosticText(message, MAX_ERROR_CHARS))),
    );

  const handleWireEvent = makeRunEventHandler({
    mutateView,
    settle,
    notify,
    failPendingResponses,
    failRun,
  });

  const start: SubagentServiceShape["start"] = (request) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!request.task.trim())
          return yield* new InvalidSubagentRequestError({ message: "Subagent task is required." });
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
            const retainedProcesses = [...records.values()].filter(
              (record) => record.view.state !== "stopped" && record.view.state !== "failed",
            ).length;
            if (retainedProcesses >= MAX_RUNS)
              return yield* new SubagentCapacityError({
                limit: MAX_RUNS,
                message: `Subagent capacity reached (${MAX_RUNS}). Stop an existing run first.`,
              });
            if (request.writeIntent === "writer") {
              const activeWriter = [...records.values()].find(
                (record) =>
                  record.view.writeIntent === "writer" && isActiveRunState(record.view.state),
              );
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
              model: request.model,
              effort: request.effort,
              startedAt: now,
              lastActivityAt: now,
              transcript: [],
              usage: emptyUsage(),
            };
            const record: RunRecord = {
              view,
              scope,
              responses: new Map(),
              nextRpcId: 1,
              settlement,
              foregroundOutcome,
              pauseRequested: false,
              stoppedByParent: false,
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
          cwd: request.cwd,
          context: request.context,
          model: request.model,
          effort: request.effort,
          activeTools: request.activeTools,
          projectTrusted: request.projectTrusted,
          parentSessionId: request.parentSessionId,
          ...(request.parentSessionFile ? { parentSessionFile: request.parentSessionFile } : {}),
          ...(request.parentLeafId ? { parentLeafId: request.parentLeafId } : {}),
          systemPrompt: childSystemPrompt(request),
        };

        const initialize = Effect.gen(function* () {
          const process = yield* childProcesses
            .spawn(launch)
            .pipe(Effect.provideService(Scope.Scope, scope));
          reserved.process = process;
          reserved.view = { ...reserved.view, pid: process.pid };
          publish();
          yield* Stream.fromQueue(process.events).pipe(
            Stream.runForEach((event) =>
              handleWireEvent(reserved, event).pipe(
                Effect.catch((error) => failRun(reserved, error.message).pipe(Effect.asVoid)),
              ),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          yield* process.awaitExit.pipe(
            Effect.flatMap((event) => handleWireEvent(reserved, event)),
            Effect.catch((error) => failRun(reserved, error.message).pipe(Effect.asVoid)),
            Effect.forkIn(scope, { startImmediately: true }),
          );
          const stateResponse = yield* rpc(reserved, { type: "get_state" });
          const state = yield* decodeRpcStateData(stateResponse.data).pipe(
            Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
          );
          if (request.effortWasExplicit && state.thinkingLevel !== request.effort)
            return yield* new InvalidSubagentRequestError({
              message: `Model ${request.model} does not support requested effort ${request.effort}; effective level was ${state.thinkingLevel}.`,
            });
          const startedAt = yield* Clock.currentTimeMillis;
          reserved.view = {
            ...reserved.view,
            state: "running",
            effort: state.thinkingLevel as StartSubagentRequest["effort"],
            lastActivityAt: startedAt,
            ...(state.sessionFile ? { sessionFile: state.sessionFile } : {}),
          };
          publish();
          yield* rpc(reserved, { type: "prompt", message: taskPrompt(request, peerNotice) });
          yield* sendPeerNotices(reserved.view.id);
          return snapshotView(reserved.view);
        });

        return yield* restore(initialize).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const message = sanitizeDiagnosticText(Cause.pretty(cause), MAX_ERROR_CHARS);
              yield* settle(reserved, "failed", message);
              yield* Scope.close(scope, Exit.void);
            }),
          ),
        );
      }),
    );

  const waitForForeground: SubagentServiceShape["waitForForeground"] = (id) =>
    Effect.flatMap(requireRecord(id), (record) => Deferred.await(record.foregroundOutcome));
  const list = withLock(
    Effect.sync(() => sortRuns([...records.values()].map((record) => snapshotView(record.view)))),
  );
  const status: SubagentServiceShape["status"] = (id) =>
    withLock(
      Effect.flatMap(requireRecord(id), (record) => Effect.succeed(snapshotView(record.view))),
    );

  const send: SubagentServiceShape["send"] = (id, message) =>
    Effect.gen(function* () {
      if (!message.trim())
        return yield* new InvalidSubagentRequestError({ message: "Guidance message is required." });
      const record = yield* requireRecord(id);
      if (record.view.state === "waiting_for_parent")
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${id} is waiting for a reply; use action=reply.`,
        });
      if (record.view.state !== "running" && record.view.state !== "starting")
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${id} is ${record.view.state}; use action=resume.`,
        });
      yield* rpc(record, { type: "steer", message: message.trim() });
      return yield* mutateView(record, (current) => ({
        ...current,
        transcript: appendTranscript(current.transcript, `parent guidance: ${message.trim()}`),
      }));
    });

  const reply: SubagentServiceShape["reply"] = (id, message) =>
    Effect.gen(function* () {
      if (!message.trim())
        return yield* new InvalidSubagentRequestError({ message: "Reply message is required." });
      const record = yield* requireRecord(id);
      const question = record.view.question;
      if (!question)
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${id} has no pending parent question.`,
        });
      const process = record.process;
      if (!process)
        return yield* new SubagentProcessError({
          operation: "reply to",
          message: `Subagent ${id} has no active process.`,
        });
      const envelope: ParentReply = {
        channel: "pi-subagents",
        type: "parent_reply",
        requestId: question.requestId,
        message: message.trim(),
      };
      yield* process.sendIpc(envelope);
      return yield* mutateView(record, (current) => ({
        ...current,
        state: "running",
        question: undefined,
        transcript: appendTranscript(current.transcript, `parent reply: ${message.trim()}`),
      }));
    });

  const interrupt: SubagentServiceShape["interrupt"] = (id) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(id);
      if (record.view.state !== "running" && record.view.state !== "waiting_for_parent")
        return yield* new InvalidSubagentRequestError({
          message: `Subagent ${id} cannot be interrupted while ${record.view.state}.`,
        });
      record.pauseRequested = true;
      yield* rpc(record, { type: "abort" }).pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            record.pauseRequested = false;
          }),
        ),
      );
      const now = yield* Clock.currentTimeMillis;
      return yield* mutateView(record, (current) => ({
        ...current,
        state: "paused",
        question: undefined,
        currentTool: undefined,
        lastActivityAt: now,
      }));
    });

  const resume: SubagentServiceShape["resume"] = (id, message) =>
    Effect.gen(function* () {
      const nextSettlement = yield* Deferred.make<SubagentRunView>();
      const now = yield* Clock.currentTimeMillis;
      const record = yield* withLock(
        Effect.gen(function* () {
          const selected = yield* requireRecord(id);
          if (selected.view.state !== "paused" && selected.view.state !== "completed")
            return yield* new InvalidSubagentRequestError({
              message: `Subagent ${id} cannot resume while ${selected.view.state}.`,
            });
          if (selected.view.writeIntent === "writer") {
            const activeWriter = [...records.values()].find(
              (candidate) =>
                candidate !== selected &&
                candidate.view.writeIntent === "writer" &&
                isActiveRunState(candidate.view.state),
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
          selected.view = {
            ...selected.view,
            state: "starting",
            endedAt: undefined,
            error: undefined,
            lastActivityAt: now,
          };
          publish();
          return selected;
        }),
      );
      const prompt =
        message?.trim() || "Continue the assigned task from the current session state.";
      yield* rpc(record, { type: "prompt", message: prompt }).pipe(
        Effect.onError((cause) => failRun(record, Cause.pretty(cause)).pipe(Effect.asVoid)),
      );
      const view = yield* mutateView(record, (current) =>
        current.state === "starting"
          ? {
              ...current,
              state: "running",
              lastActivityAt: now,
              transcript: appendTranscript(current.transcript, `parent resumed: ${prompt}`),
            }
          : current,
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
      yield* rpc(record, { type: "set_session_name", name });
      const view = yield* mutateView(record, (current) => ({ ...current, name }));
      yield* sendPeerNotices(id);
      return view;
    });

  const stop: SubagentServiceShape["stop"] = (id) =>
    Effect.gen(function* () {
      const record = yield* requireRecord(id);
      if (record.view.state === "stopped") return snapshotView(record.view);
      record.stoppedByParent = true;
      yield* mutateView(record, (current) => ({ ...current, state: "stopping" }));
      failPendingResponses(
        record,
        new SubagentProcessError({ operation: "stop", message: `Subagent ${id} was stopped.` }),
      );
      yield* Scope.close(record.scope, Exit.void);
      return yield* settle(record, "stopped");
    });

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
