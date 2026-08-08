import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  LocalCliProcess,
  type LocalCliHandle,
  type LocalCliProcessShape,
  type LocalCliWireEvent,
} from "../boundary/local-cli-process.ts";
import {
  SupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelShape,
} from "../boundary/supervisor-channel.ts";
import {
  SubagentProcessError,
  SubagentProtocolError,
  UnsupportedSubagentCapabilityError,
  type SubagentError,
} from "../run/errors.ts";
import { SUBAGENT_FAST_SERVICE_TIER } from "../run/fast-mode.ts";
import type { SubagentUsage } from "../run/model.ts";
import {
  decodeCodexEnvelope,
  decodeCodexNotification,
  decodeEmptyResult,
  decodeInitializeResult,
  decodeThreadStartResult,
  decodeTurnStartResult,
  decodeTurnSteerResult,
  initializedNotification,
  initializeRequest,
  threadStartRequest,
  turnInterruptRequest,
  turnStartRequest,
  turnSteerRequest,
  type CodexRequest,
} from "./local-codex-protocol.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "./model.ts";
import { withLocalSupervisorInstructions } from "./local-supervisor-prompt.ts";

const EVENT_CAPACITY = 512;
const RPC_TIMEOUT = "10 seconds";

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });
const protocolError = (message: string) => new SubagentProtocolError({ message });
const unsupported = (capability: string) =>
  new UnsupportedSubagentCapabilityError({
    backend: "local/codex",
    capability,
    message: `Local Codex app-server does not expose ${capability} in the hardened protocol subset.`,
  });

interface PendingResponse {
  readonly method: CodexRequest["method"];
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

interface PendingInterrupt {
  readonly turnId: string;
  readonly assignmentEpoch: number;
  readonly completion: Deferred.Deferred<void, SubagentError>;
  /**
   * Set when the public interrupt call timed out with an uncertain outcome. The
   * lifecycle then remains exactly owned: a late matching interrupted turn
   * completion settles the assignment through `run_settled` instead of failing.
   */
  abandoned: boolean;
  completionSeen: boolean;
}

const outcomeCode = (method: CodexRequest["method"]): string => {
  switch (method) {
    case "turn/start":
      return "start_outcome_uncertain";
    case "turn/steer":
      return "guidance_outcome_uncertain";
    case "turn/interrupt":
      return "interrupt_outcome_uncertain";
    default:
      return `${method.replaceAll("/", "_")}_outcome_uncertain`;
  }
};

/**
 * Item classification: only known executable item types own a
 * tool_started/tool_finished lifecycle. Reasoning and other informational items
 * surface as activity, forbidden nested-agent/collaboration items stay fatal,
 * and unknown future item types never fabricate tool lifecycle entries.
 */
const FORBIDDEN_ITEM_TYPES: ReadonlySet<string> = new Set([
  "collabAgentToolCall",
  "subAgentActivity",
]);
const EXECUTABLE_ITEM_TOOL_NAMES: Readonly<Record<string, string>> = {
  commandExecution: "Bash",
  fileChange: "ApplyPatch",
  webSearch: "WebSearch",
};

const executableToolName = (item: {
  readonly type: string;
  readonly server?: string | undefined;
  readonly tool?: string | undefined;
}): string | undefined => {
  if (item.type === "mcpToolCall")
    return `mcp:${item.server ?? "unknown"}/${item.tool ?? "unknown"}`;
  return EXECUTABLE_ITEM_TOOL_NAMES[item.type];
};

const usageDelta = (
  previous: SubagentUsage,
  total: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    readonly cacheWriteInputTokens?: number | undefined;
  },
): SubagentUsage => ({
  input: Math.max(0, total.inputTokens - previous.input),
  output: Math.max(0, total.outputTokens - previous.output),
  cacheRead: Math.max(0, total.cachedInputTokens - previous.cacheRead),
  cacheWrite: Math.max(0, (total.cacheWriteInputTokens ?? 0) - previous.cacheWrite),
  totalTokens: Math.max(0, total.totalTokens - previous.totalTokens),
  // Codex reports no client-side cost; it remains unknown rather than a known $0.
});

const makeLocalCodexHandle = Effect.fn("LocalCodexBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliHandle,
  supervisor: SupervisorChannelHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const responses = new Map<string, PendingResponse>();
  const rawOwners = new Map<BackendEvent, LocalCliWireEvent>();
  let nextRequestId = 1;
  let assignmentEpoch = 0;
  let threadId: string | undefined;
  let sessionId: string | undefined;
  let activeTurnId: string | undefined;
  let runStartedTurnId: string | undefined;
  let pendingInterrupt: PendingInterrupt | undefined;
  let cumulativeUsage: SubagentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };

  const acknowledge = (event: BackendEvent) => {
    const raw = rawOwners.get(event);
    if (!raw) return;
    rawOwners.delete(event);
    child.acknowledge(raw);
  };
  const acknowledgeAll = () => {
    for (const raw of rawOwners.values()) child.acknowledge(raw);
    rawOwners.clear();
  };
  const cancelPending = (error: SubagentError) => {
    for (const pending of responses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    responses.clear();
    if (pendingInterrupt) {
      Deferred.doneUnsafe(pendingInterrupt.completion, Effect.fail(error));
      pendingInterrupt = undefined;
    }
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancelPending(processError("close", "local_codex_closed", "Local Codex backend closed."));
      acknowledgeAll();
      Queue.endUnsafe(events);
    }),
  );

  const offer = (event: BackendEvent, raw?: LocalCliWireEvent) =>
    Effect.suspend(() => {
      if (raw) rawOwners.set(event, raw);
      let offered = false;
      return Queue.offer(events, event).pipe(
        Effect.tap(() => Effect.sync(() => void (offered = true))),
        Effect.ensuring(
          Effect.sync(() => {
            if (!offered && raw) acknowledge(event);
          }),
        ),
        Effect.asVoid,
      );
    });

  const consumeNotification = (
    raw: LocalCliWireEvent,
    method: string,
    params: unknown,
  ): Effect.Effect<void> =>
    decodeCodexNotification(method, params).pipe(
      Effect.flatMap((event) => {
        if (event.type === "ignored") {
          child.acknowledge(raw);
          return Effect.void;
        }
        if (event.type === "warning")
          return offer(
            { type: "warning", source: "runtime-extension", message: event.message },
            raw,
          );
        if ("threadId" in event && threadId && event.threadId !== threadId) {
          child.acknowledge(raw);
          return Effect.void;
        }
        switch (event.type) {
          case "turn_started":
            activeTurnId = event.turnId;
            if (runStartedTurnId === event.turnId) {
              child.acknowledge(raw);
              return Effect.void;
            }
            runStartedTurnId = event.turnId;
            return offer({ type: "run_started", assignmentEpoch }, raw);
          case "agent_delta":
            return event.turnId === activeTurnId
              ? offer({ type: "activity", assignmentEpoch }, raw)
              : Effect.sync(() => child.acknowledge(raw));
          case "usage": {
            if (event.turnId !== activeTurnId) {
              child.acknowledge(raw);
              return Effect.void;
            }
            const delta = usageDelta(cumulativeUsage, event.total);
            cumulativeUsage = {
              input: event.total.inputTokens,
              output: event.total.outputTokens,
              cacheRead: event.total.cachedInputTokens,
              cacheWrite: event.total.cacheWriteInputTokens ?? 0,
              totalTokens: event.total.totalTokens,
            };
            return offer({ type: "assistant_message", assignmentEpoch, usage: delta }, raw);
          }
          case "item_started": {
            if (event.turnId !== activeTurnId) {
              child.acknowledge(raw);
              return Effect.void;
            }
            if (FORBIDDEN_ITEM_TYPES.has(event.item.type))
              return offer(
                {
                  type: "protocol_error",
                  message: "Codex emitted forbidden multi-agent activity.",
                },
                raw,
              );
            const tool = executableToolName(event.item);
            if (tool === undefined)
              // agentMessage, reasoning, and unknown future informational items
              // are activity; they never fabricate a tool lifecycle entry.
              return offer({ type: "activity", assignmentEpoch }, raw);
            return offer(
              {
                type: "tool_started",
                assignmentEpoch,
                toolCallId: event.item.id,
                toolName: tool,
                args:
                  event.item.arguments ??
                  (event.item.command ? { command: event.item.command } : {}),
              },
              raw,
            );
          }
          case "item_completed": {
            if (event.turnId !== activeTurnId) {
              child.acknowledge(raw);
              return Effect.void;
            }
            if (FORBIDDEN_ITEM_TYPES.has(event.item.type))
              return offer(
                {
                  type: "protocol_error",
                  message: "Codex emitted forbidden multi-agent activity.",
                },
                raw,
              );
            if (event.item.type === "agentMessage")
              return offer(
                {
                  type: "assistant_message",
                  assignmentEpoch,
                  ...(event.item.text ? { text: event.item.text } : {}),
                  usage: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                    totalTokens: 0,
                  },
                },
                raw,
              );
            const tool = executableToolName(event.item);
            if (tool === undefined) {
              // Completion of an informational or unknown item is acknowledged
              // without a fabricated tool_finished, matching item_started.
              child.acknowledge(raw);
              return Effect.void;
            }
            return offer(
              {
                type: "tool_finished",
                assignmentEpoch,
                toolCallId: event.item.id,
                toolName: tool,
                isError: event.item.status === "failed" || event.item.status === "declined",
              },
              raw,
            );
          }
          case "turn_completed": {
            if (event.turnId !== activeTurnId) {
              child.acknowledge(raw);
              return Effect.void;
            }
            const completedEpoch = assignmentEpoch;
            activeTurnId = undefined;
            if (runStartedTurnId === event.turnId) runStartedTurnId = undefined;
            const interrupt = pendingInterrupt;
            if (event.status === "interrupted") {
              if (
                interrupt?.turnId === event.turnId &&
                interrupt.assignmentEpoch === completedEpoch
              ) {
                interrupt.completionSeen = true;
                if (interrupt.abandoned) {
                  // The exact native interrupted settlement arrived after the
                  // public interrupt timed out; settle it as a pause rather
                  // than failing the run.
                  pendingInterrupt = undefined;
                  return offer(
                    { type: "run_settled", assignmentEpoch: interrupt.assignmentEpoch },
                    raw,
                  );
                }
                Deferred.doneUnsafe(interrupt.completion, Effect.void);
                child.acknowledge(raw);
                return Effect.void;
              }
              return offer(
                {
                  type: "protocol_error",
                  message:
                    "Codex turn was interrupted without a matching parent interrupt lifecycle.",
                },
                raw,
              );
            }
            if (event.status === "failed")
              return offer(
                {
                  type: "protocol_error",
                  message: event.diagnostic
                    ? `Codex turn failed: ${event.diagnostic}`
                    : "Codex turn failed before a supervisor report was accepted.",
                },
                raw,
              );
            // The MCP helper receives its report result only after SupervisorChannel records
            // accepted epoch evidence. Codex cannot complete the tool call and then the turn
            // before that causal write, so this query is independent of adapter queue scheduling.
            return supervisor.hasAcceptedReport(completedEpoch).pipe(
              Effect.mapError((error) =>
                protocolError(
                  `Unable to confirm Codex supervisor report ownership: ${error.message}`,
                ),
              ),
              Effect.flatMap((accepted) =>
                accepted
                  ? Effect.sync(() => child.acknowledge(raw))
                  : offer(
                      {
                        type: "protocol_error",
                        message: "Codex turn completed without an accepted supervisor report.",
                      },
                      raw,
                    ),
              ),
            );
          }
        }
      }),
      Effect.catch(() =>
        offer(
          { type: "protocol_error", message: "Codex emitted an invalid v2 notification." },
          raw,
        ),
      ),
    );

  const consumeRaw = (raw: LocalCliWireEvent): Effect.Effect<void> => {
    if (raw.type === "protocol_error")
      return offer({ type: "protocol_error", message: raw.message }, raw);
    if (raw.type === "exit") {
      child.acknowledge(raw);
      return Effect.void;
    }
    return decodeCodexEnvelope(raw.value).pipe(
      Effect.flatMap((envelope) => {
        if (envelope.type === "server_request")
          return offer(
            {
              type: "protocol_error",
              message: `Codex requested unsupported server method ${envelope.method}.`,
            },
            raw,
          );
        if (envelope.type === "notification")
          return consumeNotification(raw, envelope.method, envelope.params);
        const pending = responses.get(String(envelope.id));
        if (!pending) {
          child.acknowledge(raw);
          return Effect.void;
        }
        responses.delete(String(envelope.id));
        Deferred.doneUnsafe(
          pending.deferred,
          envelope.error
            ? Effect.fail(
                processError(
                  `execute ${pending.method}`,
                  "codex_request_rejected",
                  envelope.error.message,
                ),
              )
            : Effect.succeed(envelope.result),
        );
        child.acknowledge(raw);
        return Effect.void;
      }),
      Effect.catch(() =>
        offer({ type: "protocol_error", message: "Codex emitted an invalid JSON-RPC frame." }, raw),
      ),
    );
  };

  const preserveAcceptedReport = Effect.suspend(() =>
    assignmentEpoch <= 0
      ? Effect.void
      : supervisor.acceptedReportForEpoch(assignmentEpoch).pipe(
          Effect.flatMap((report) =>
            report
              ? offer({ type: "report", ...report }).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.asVoid,
                )
              : Effect.void,
          ),
          Effect.catch((error) =>
            offer({
              type: "protocol_error",
              message: `Unable to preserve accepted Codex report during transport shutdown: ${error.message}`,
            }),
          ),
        ),
  );

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeRaw),
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() =>
        cancelPending(
          processError("run", "local_codex_transport_closed", "Local Codex transport closed."),
        ),
      ).pipe(
        Effect.andThen(preserveAcceptedReport),
        Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach((event) => offer(event)),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const rpc = (makeRequest: (id: string) => CodexRequest): Effect.Effect<unknown, SubagentError> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const request = makeRequest(`codex-${nextRequestId++}`);
        const deferred = Deferred.makeUnsafe<unknown, SubagentError>();
        responses.set(request.id, { method: request.method, deferred });
        return { request, deferred };
      }),
      ({ request: frame, deferred }) =>
        child.send(frame).pipe(
          Effect.mapError((error) =>
            error.code === "transport_outcome_uncertain"
              ? processError(
                  `execute ${frame.method}`,
                  outcomeCode(frame.method),
                  `${frame.method} may already have applied; inspect status before retrying. (${error.message})`,
                )
              : error,
          ),
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption(RPC_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.succeed(outcome.value)
              : Effect.fail(
                  processError(
                    `execute ${frame.method}`,
                    outcomeCode(frame.method),
                    `${frame.method} was sent but no correlated response arrived; it will not be retried automatically.`,
                  ),
                ),
          ),
        ),
      ({ request: frame }) => Effect.sync(() => void responses.delete(frame.id)),
    );

  const initialize = Effect.gen(function* () {
    yield* rpc(initializeRequest).pipe(
      Effect.flatMap((value) =>
        decodeInitializeResult(value).pipe(
          Effect.mapError(() => protocolError("Codex returned an invalid initialize result.")),
        ),
      ),
    );
    yield* child.send(initializedNotification());
    const started = yield* rpc((id) =>
      threadStartRequest(id, {
        cwd: request.cwd,
        model: request.model,
        systemPrompt: request.systemPrompt,
        writeIntent: request.writeIntent,
        fastMode: request.fastMode,
      }),
    ).pipe(
      Effect.flatMap((value) =>
        decodeThreadStartResult(value).pipe(
          Effect.mapError(() => protocolError("Codex returned an invalid thread/start result.")),
        ),
      ),
    );
    if (started.model !== request.model)
      return yield* protocolError(
        `Codex selected model ${started.model} instead of required model ${request.model}.`,
      );
    if (request.fastMode && started.serviceTier !== SUBAGENT_FAST_SERVICE_TIER)
      return yield* protocolError(
        `Codex selected service tier ${started.serviceTier ?? "default"} instead of required ${SUBAGENT_FAST_SERVICE_TIER} fast mode.`,
      );
    threadId = started.thread.id;
    sessionId = started.thread.sessionId ?? started.thread.id;
    yield* supervisor.awaitReady.pipe(
      Effect.mapError((error) => processError("initialize", error.code, error.message)),
    );
    return {
      model: started.model,
      effort: request.effort,
      sessionId,
    };
  });

  const requireThread = (): Effect.Effect<string, SubagentProcessError> =>
    threadId
      ? Effect.succeed(threadId)
      : Effect.fail(
          processError("control", "codex_thread_uninitialized", "Codex thread is not initialized."),
        );
  const requireActiveTurn = (): Effect.Effect<
    { readonly threadId: string; readonly turnId: string },
    SubagentProcessError
  > =>
    threadId && activeTurnId
      ? Effect.succeed({ threadId, turnId: activeTurnId })
      : Effect.fail(
          processError("control", "codex_turn_inactive", "Codex has no active steerable turn."),
        );

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(
      Effect.map((event) => ({
        type: "exit" as const,
        exitCode: event.exitCode,
        ...(event.signal ? { signal: event.signal } : {}),
        diagnostic: event.stderr,
      })),
    ),
    controls: {
      initialize,
      start: (message: string, epoch: number) =>
        Effect.suspend(() => {
          const previousEpoch = assignmentEpoch;
          return supervisor.setAssignmentEpoch(epoch).pipe(
            Effect.mapError((error) => processError("start", error.code, error.message)),
            Effect.andThen(requireThread()),
            Effect.tap(() =>
              Effect.sync(() => {
                // Runtime notifications can race ahead of the correlated response.
                assignmentEpoch = epoch;
              }),
            ),
            Effect.flatMap((currentThreadId) =>
              rpc((id) =>
                turnStartRequest(
                  id,
                  currentThreadId,
                  message,
                  request.model,
                  request.effort,
                  request.writeIntent,
                  request.fastMode,
                ),
              ).pipe(
                Effect.flatMap((value) =>
                  decodeTurnStartResult(value).pipe(
                    Effect.mapError(() =>
                      protocolError("Codex returned an invalid turn/start result."),
                    ),
                  ),
                ),
                Effect.flatMap((started) =>
                  Effect.sync(() => {
                    activeTurnId = started.turn.id;
                    if (runStartedTurnId === started.turn.id) return false;
                    runStartedTurnId = started.turn.id;
                    return true;
                  }).pipe(
                    Effect.flatMap((emitStarted) =>
                      emitStarted
                        ? offer({ type: "run_started", assignmentEpoch: epoch })
                        : Effect.void,
                    ),
                  ),
                ),
              ),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                const uncertain =
                  error._tag === "SubagentProcessError" &&
                  error.code?.endsWith("_outcome_uncertain") === true;
                if (!uncertain && !activeTurnId && assignmentEpoch === epoch)
                  assignmentEpoch = previousEpoch;
              }),
            ),
          );
        }),
      steer: (message: string) =>
        requireActiveTurn().pipe(
          Effect.flatMap(({ threadId: currentThreadId, turnId }) =>
            rpc((id) => turnSteerRequest(id, currentThreadId, turnId, message)).pipe(
              Effect.flatMap((value) =>
                decodeTurnSteerResult(value).pipe(
                  Effect.mapError(() =>
                    protocolError("Codex returned an invalid turn/steer result."),
                  ),
                ),
              ),
              Effect.flatMap((result) =>
                result.turnId === turnId
                  ? Effect.void
                  : Effect.fail(
                      protocolError("Codex turn/steer confirmed a different active turn."),
                    ),
              ),
            ),
          ),
        ),
      interrupt: Effect.suspend(() =>
        requireActiveTurn().pipe(
          Effect.flatMap(({ threadId: currentThreadId, turnId }) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                if (pendingInterrupt)
                  return {
                    lifecycle: undefined,
                    error: processError(
                      "interrupt",
                      "interrupt_not_sent",
                      pendingInterrupt.abandoned
                        ? "A previous Codex interrupt lifecycle is still unresolved; a second interrupt would be ambiguously correlated."
                        : "Another Codex interrupt lifecycle is already pending.",
                    ),
                  } as const;
                const lifecycle: PendingInterrupt = {
                  turnId,
                  assignmentEpoch,
                  completion: Deferred.makeUnsafe<void, SubagentError>(),
                  abandoned: false,
                  completionSeen: false,
                };
                pendingInterrupt = lifecycle;
                return { lifecycle } as const;
              }),
              (acquired) => {
                if (!acquired.lifecycle) return Effect.fail(acquired.error);
                const response = rpc((id) =>
                  turnInterruptRequest(id, currentThreadId, turnId),
                ).pipe(
                  Effect.flatMap((value) =>
                    decodeEmptyResult(value).pipe(
                      Effect.mapError(() =>
                        protocolError("Codex returned an invalid turn/interrupt result."),
                      ),
                    ),
                  ),
                  Effect.asVoid,
                );
                return Effect.all([response, Deferred.await(acquired.lifecycle.completion)], {
                  concurrency: "unbounded",
                  discard: true,
                }).pipe(
                  Effect.timeoutOption(RPC_TIMEOUT),
                  Effect.flatMap((outcome) =>
                    Option.isSome(outcome)
                      ? Effect.void
                      : Effect.fail(
                          processError(
                            "interrupt",
                            "interrupt_outcome_uncertain",
                            "Codex interrupt did not receive both its correlated JSON-RPC response and matching interrupted turn completion.",
                          ),
                        ),
                  ),
                );
              },
              (acquired, exit) =>
                Effect.suspend(() => {
                  if (!acquired.lifecycle || pendingInterrupt !== acquired.lifecycle)
                    return Effect.void;
                  // An uncertain or cancelled interrupt retains exact lifecycle
                  // ownership so a late matching interrupted completion pauses
                  // through run_settled. Definite outcomes release ownership.
                  const retainOwnership =
                    Exit.isFailure(exit) &&
                    (exit.cause.reasons.every(Cause.isInterruptReason) ||
                      (() => {
                        const error = Cause.squash(exit.cause);
                        return (
                          typeof error === "object" &&
                          error !== null &&
                          "_tag" in error &&
                          error._tag === "SubagentProcessError" &&
                          (error as SubagentProcessError).code === "interrupt_outcome_uncertain"
                        );
                      })());
                  if (!retainOwnership) {
                    pendingInterrupt = undefined;
                    return Effect.void;
                  }
                  acquired.lifecycle.abandoned = true;
                  // Native terminal evidence may have arrived before timeout while
                  // only the JSON-RPC response was missing. Bridge it immediately;
                  // otherwise no later event would remain to settle the pause.
                  if (!acquired.lifecycle.completionSeen) return Effect.void;
                  pendingInterrupt = undefined;
                  return offer({
                    type: "run_settled",
                    assignmentEpoch: acquired.lifecycle.assignmentEpoch,
                  });
                }),
            ),
          ),
        ),
      ),
      renameDisplay: () => Effect.fail(unsupported("rename-display")),
      reply: (requestId: string, message: string) =>
        supervisor
          .reply(requestId, message)
          .pipe(Effect.mapError((error) => processError("reply", error.code, error.message))),
      notifyPeers: () => Effect.fail(unsupported("peer-notice")),
    },
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const makeLocalCodexBackendDriver = (
  processes: LocalCliProcessShape,
  supervisors: SupervisorChannelShape,
): BackendDriver => ({
  host: "local",
  runtime: "codex",
  capabilities: ["steer", "interrupt", "parent-contact"],
  supportsContext: (context) => context === "fresh",
  preflight: (request) => processes.preflight({ runtime: "codex", ...request }),
  spawn: (request) =>
    Effect.gen(function* () {
      const launch = withLocalSupervisorInstructions(request);
      const supervisor = yield* supervisors
        .open({ runId: request.runId })
        .pipe(
          Effect.mapError((error) =>
            processError("open supervisor channel", error.code, error.message),
          ),
        );
      const child = yield* processes.spawn({
        runtime: "codex",
        launch,
        supervisor: supervisor.metadata,
      });
      return yield* makeLocalCodexHandle(launch, child, supervisor);
    }),
});

export const localCodexBackendDriver = Effect.gen(function* () {
  const processes = yield* LocalCliProcess;
  const supervisors = yield* SupervisorChannel;
  return makeLocalCodexBackendDriver(processes, supervisors);
});
