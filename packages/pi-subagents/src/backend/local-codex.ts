import { toolOutputPreview } from "./tool-output-preview.ts";
import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Predicate from "effect/Predicate";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../boundary/supervisor-channel.ts";
import { isOutcomeUncertain, processError, type SubagentError } from "../run/errors.ts";
import { emptyUsage, type SubagentUsage } from "../run/model.ts";
import {
  decodeCodexEnvelope,
  decodeCodexNotification,
  EmptyObject,
  InitializeResult,
  initializedNotification,
  initializeRequest,
  codexSandboxPolicy,
  ThreadStartResult,
  threadStartRequest,
  turnInterruptRequest,
  TurnStartResult,
  turnStartRequest,
  turnSteerRequest,
  TurnSteerResult,
  executableToolName,
  outcomeCode,
  type CodexNotification,
  type CodexRequest,
} from "./local-codex-protocol.ts";
import { localCliInterrupts, type LocalCliInterrupt } from "./local-cli-interruption.ts";
import type { BackendLaunchRequest } from "./model.ts";
import { localCliEventIngress } from "./local-cli-events.ts";
import {
  correlatedRequest,
  oversizedLineError,
  protocolError,
  supervisorError,
} from "./driver-shared.ts";
import {
  consumeUntilExit,
  deliverTerminalReport,
  localCliBackendDriver,
  localCliBackendExit,
  missingReportMessage,
  REPORT_REMINDER,
} from "./local-cli-driver.ts";

const RPC_TIMEOUT = "10 seconds";
// Bounds the threads one Codex process can account; later threads go uncounted, never recounted.
const MAX_USAGE_THREADS = 64;

interface PendingResponse {
  readonly method: CodexRequest["method"];
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

interface PendingInterrupt extends LocalCliInterrupt {
  readonly turnId: string;
}

type CodexUsage = Extract<CodexNotification, { readonly type: "usage" }>;
type CodexItemEvent = Extract<CodexNotification, { type: "item_started" | "item_completed" }>;
type CodexTurnCompleted = Extract<CodexNotification, { readonly type: "turn_completed" }>;

const makeLocalCodexHandle = Effect.fn("LocalCodexBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliProcessHandle,
  supervisor: SupervisorChannelHandle,
) {
  const scope = yield* Scope.Scope;
  const sandboxPolicy = codexSandboxPolicy(request.writeIntent, child.temporaryDirectory);
  const { events, offer, release, acknowledge } = yield* localCliEventIngress(child.acknowledge);
  const responses = new Map<string, PendingResponse>();
  let nextRequestId = 1;
  let assignmentEpoch = 0;
  let threadId: string | undefined;
  let sessionId: string | undefined;
  let activeTurnId: string | undefined;
  let runStartedTurnId: string | undefined;
  let runStartedEpoch: number | undefined;
  /** The active turn's latest agent message, for a missing-report failure. */
  let turnFinalText: string | undefined;
  /** The assignment already reminded once to submit its missing report. */
  let reportReminderEpoch: number | undefined;
  const interrupts = localCliInterrupts<PendingInterrupt>(
    "Codex",
    { offer, release },
    () => assignmentEpoch,
  );
  // Each thread reports only its own running total; native sub-agents run in their own threads.
  const threadUsage = new Map<string, SubagentUsage>();

  const cancelPending = (error: SubagentError) => {
    for (const pending of responses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    responses.clear();
    interrupts.cancel(error);
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() =>
      cancelPending(processError("close", "local_codex_closed", "Local Codex backend closed.")),
    ),
  );

  const onUsage = (event: CodexUsage, raw: LocalCliWireEvent) => {
    const known = threadUsage.get(event.threadId);
    if (known === undefined && threadUsage.size >= MAX_USAGE_THREADS) return release(raw);
    const previous = known ?? emptyUsage();
    const delta: SubagentUsage = {
      input: Math.max(0, event.total.inputTokens - previous.input),
      output: Math.max(0, event.total.outputTokens - previous.output),
      cacheRead: Math.max(0, event.total.cachedInputTokens - previous.cacheRead),
      cacheWrite: Math.max(0, (event.total.cacheWriteInputTokens ?? 0) - previous.cacheWrite),
      totalTokens: Math.max(0, event.total.totalTokens - previous.totalTokens),
    };
    threadUsage.set(event.threadId, {
      input: Math.max(previous.input, event.total.inputTokens),
      output: Math.max(previous.output, event.total.outputTokens),
      cacheRead: Math.max(previous.cacheRead, event.total.cachedInputTokens),
      cacheWrite: Math.max(previous.cacheWrite, event.total.cacheWriteInputTokens ?? 0),
      totalTokens: Math.max(previous.totalTokens, event.total.totalTokens),
    });
    return offer({ type: "assistant_message", assignmentEpoch, usage: delta }, raw);
  };

  const onItemStarted = (event: CodexItemEvent, raw: LocalCliWireEvent) => {
    const tool = executableToolName(event.item);
    if (tool === undefined) return offer({ type: "activity", assignmentEpoch }, raw);
    return offer(
      {
        type: "tool_started",
        assignmentEpoch,
        toolCallId: event.item.id,
        toolName: tool,
        args:
          event.item.type === "fileChange"
            ? { changes: event.item.changes ?? [] }
            : (event.item.arguments ?? (event.item.command ? { command: event.item.command } : {})),
      },
      raw,
    );
  };

  const onItemCompleted = (event: CodexItemEvent, raw: LocalCliWireEvent) => {
    if (event.item.type === "agentMessage") {
      turnFinalText = event.item.text;
      return offer(
        {
          type: "assistant_message" as const,
          assignmentEpoch,
          ...(event.item.text !== undefined &&
            event.item.text.length > 0 && { text: event.item.text }),
          usage: emptyUsage(),
        },
        raw,
      );
    }
    const tool = executableToolName(event.item);
    if (tool === undefined) return release(raw);
    return offer(
      {
        type: "tool_finished",
        assignmentEpoch,
        toolCallId: event.item.id,
        toolName: tool,
        isError: event.item.status === "failed" || event.item.status === "declined",
        outputPreview: toolOutputPreview(event.item.aggregatedOutput ?? undefined),
      },
      raw,
    );
  };

  // A report reminder starts a second turn in the same assignment, which is not a new start.
  const markTurnStarted = (turnId: string, epoch: number, raw?: LocalCliWireEvent) => {
    activeTurnId = turnId;
    const announce = runStartedTurnId !== turnId && runStartedEpoch !== epoch;
    runStartedTurnId = turnId;
    if (!announce) return raw ? release(raw) : Effect.void;
    runStartedEpoch = epoch;
    return offer({ type: "run_started", assignmentEpoch: epoch }, raw);
  };

  const failMissingReport = (
    finalText: string | undefined,
    reminded: boolean,
    raw?: LocalCliWireEvent,
  ) =>
    offer(
      { type: "protocol_error", message: missingReportMessage("codex", finalText, reminded) },
      raw,
    );

  // The thread is idle once its turn completes, so the one reminder starts a turn whose own
  // completion is checked for the report again; only a second miss fails the assignment.
  const missingReport = (
    epoch: number,
    finalText: string | undefined,
    raw: LocalCliWireEvent,
  ): Effect.Effect<void> => {
    if (reportReminderEpoch === epoch) return failMissingReport(finalText, true, raw);
    const thread = threadId;
    if (epoch !== assignmentEpoch || thread === undefined)
      return failMissingReport(finalText, false, raw);
    reportReminderEpoch = epoch;
    const remind = rpcResult(
      (id) =>
        turnStartRequest(
          id,
          thread,
          REPORT_REMINDER,
          request.model,
          request.effort,
          sandboxPolicy,
          request.openaiFastMode,
        ),
      TurnStartResult,
      "turn/start",
    ).pipe(
      Effect.flatMap((started) => markTurnStarted(started.turn.id, epoch)),
      Effect.catch(() => failMissingReport(finalText, false)),
    );
    // The turn/start response arrives through the consumer that is handling this completion.
    return offer({ type: "activity", assignmentEpoch: epoch }, raw).pipe(
      Effect.andThen(Effect.forkIn(remind, scope, { startImmediately: true })),
      Effect.asVoid,
    );
  };

  const onTurnCompleted = (event: CodexTurnCompleted, raw: LocalCliWireEvent) => {
    const completedEpoch = assignmentEpoch;
    const finalText = turnFinalText;
    turnFinalText = undefined;
    activeTurnId = undefined;
    if (runStartedTurnId === event.turnId) runStartedTurnId = undefined;
    const interrupt = interrupts.current;
    if (event.status === "interrupted") {
      if (interrupt?.turnId === event.turnId && interrupt.epoch === completedEpoch)
        return interrupts.complete(interrupt, raw);
      return offer(
        {
          type: "protocol_error",
          message: "Codex turn was interrupted without a matching parent interrupt lifecycle.",
        },
        raw,
      );
    }
    // Accepted supervisor reports remain authoritative even if native failure arrives
    // before the backpressured report-forwarding stream reaches the run service.
    return supervisor.hasAcceptedReport(completedEpoch).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          offer(
            {
              type: "protocol_error",
              message: `Unable to confirm Codex supervisor report ownership: ${error.message}`,
            },
            raw,
          ),
        onSuccess: (accepted) => {
          if (accepted) return release(raw);
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
          return missingReport(completedEpoch, finalText, raw);
        },
      }),
    );
  };

  const isForeignNotification = (event: CodexNotification): boolean =>
    ("threadId" in event && Boolean(threadId) && event.threadId !== threadId) ||
    ("turnId" in event && event.type !== "turn_started" && event.turnId !== activeTurnId);

  const consumeNotification = (
    raw: LocalCliWireEvent,
    method: string,
    params: Schema.Json | undefined,
  ) =>
    decodeCodexNotification(method, params).pipe(
      Effect.flatMap((event): Effect.Effect<void> => {
        if (event.type === "ignored") return release(raw);
        if (event.type === "warning")
          return offer({ type: "warning", message: event.message }, raw);
        // Every thread in this private app-server belongs to the child, so all of it is spend.
        if (event.type === "usage") return onUsage(event, raw);
        if (isForeignNotification(event)) return release(raw);
        switch (event.type) {
          case "turn_started":
            return markTurnStarted(event.turnId, assignmentEpoch, raw);
          case "agent_delta":
            return offer({ type: "activity", assignmentEpoch }, raw);
          case "native_activity":
            return offer(
              {
                type: "native_agent_activity",
                assignmentEpoch,
                activityId: event.activityId,
                kind: event.kind,
                state: event.state,
              },
              raw,
            );
          case "item_started":
            return onItemStarted(event, raw);
          case "item_completed":
            return onItemCompleted(event, raw);
          case "turn_completed":
            return onTurnCompleted(event, raw);
        }
        return absurd(event);
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
    if (raw.type === "oversized_line") return offer(oversizedLineError("Codex", raw), raw);
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
        if (!pending) return release(raw);
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
        return release(raw);
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
          Effect.flatMap((report) => (report ? offer({ type: "report", ...report }) : Effect.void)),
          Effect.catch((error) =>
            offer({
              type: "protocol_error",
              message: `Unable to preserve accepted Codex report during transport shutdown: ${error.message}`,
            }),
          ),
        ),
  );

  yield* consumeUntilExit("codex", child, consumeRaw, (failure) =>
    Effect.sync(() => cancelPending(failure)).pipe(
      Effect.andThen(deliverTerminalReport(events, preserveAcceptedReport, scope)),
    ),
  ).pipe(Effect.forkScoped);
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach((event) => offer(event)),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const rpc = (makeRequest: (id: string) => CodexRequest): Effect.Effect<unknown, SubagentError> =>
    correlatedRequest({
      timeout: RPC_TIMEOUT,
      register: (deferred) => {
        const rpcRequest = makeRequest(`codex-${nextRequestId++}`);
        responses.set(rpcRequest.id, { method: rpcRequest.method, deferred });
        return {
          frame: rpcRequest,
          unregister: Effect.sync(() => void responses.delete(rpcRequest.id)),
        };
      },
      send: (frame) =>
        child
          .send(frame)
          .pipe(
            Effect.mapError((error) =>
              error.code === "transport_outcome_uncertain"
                ? processError(
                    `execute ${frame.method}`,
                    outcomeCode(frame.method),
                    `${frame.method} may already have applied; inspect status before retrying. (${error.message})`,
                  )
                : error,
            ),
          ),
      timeoutError: (frame) =>
        processError(
          `execute ${frame.method}`,
          outcomeCode(frame.method),
          `${frame.method} was sent but no correlated response arrived; it will not be retried automatically.`,
        ),
    });

  const rpcResult = <A>(
    makeRequest: (id: string) => CodexRequest,
    schema: Schema.Decoder<A>,
    method: CodexRequest["method"],
  ): Effect.Effect<A, SubagentError> =>
    rpc(makeRequest).pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(() => protocolError(`Codex returned an invalid ${method} result.`)),
        ),
      ),
    );

  const initialize = Effect.gen(function* () {
    yield* rpcResult(initializeRequest, InitializeResult, "initialize");
    yield* child.send(initializedNotification());
    const started = yield* rpcResult(
      (id) =>
        threadStartRequest(id, {
          cwd: request.cwd,
          model: request.model,
          systemPrompt: request.systemPrompt,
          writeIntent: request.writeIntent,
          openaiFastMode: request.openaiFastMode,
        }),
      ThreadStartResult,
      "thread/start",
    );
    if (started.model !== request.model)
      return yield* protocolError(
        `Codex selected model ${started.model} instead of required model ${request.model}.`,
      );
    if (request.openaiFastMode && started.serviceTier !== FAST_SERVICE_TIER)
      return yield* protocolError(
        `Codex selected service tier ${started.serviceTier ?? "default"} instead of required ${FAST_SERVICE_TIER} fast mode.`,
      );
    threadId = started.thread.id;
    sessionId = started.thread.sessionId ?? started.thread.id;
    supervisor.setMainAgentThread(started.thread.id);
    yield* supervisor.awaitReady.pipe(Effect.mapError(supervisorError("initialize")));
    return {
      model: started.model,
      effort: request.effort,
      sessionId,
    };
  });

  const currentThread = Effect.suspend(() =>
    threadId
      ? Effect.succeed(threadId)
      : Effect.fail(
          processError("control", "codex_thread_uninitialized", "Codex thread is not initialized."),
        ),
  );
  const activeTurn = Effect.suspend(() =>
    threadId && activeTurnId
      ? Effect.succeed({ threadId, turnId: activeTurnId })
      : Effect.fail(
          processError("control", "codex_turn_inactive", "Codex has no active steerable turn."),
        ),
  );

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(Effect.map((exit) => localCliBackendExit("codex", exit))),
    controls: {
      initialize,
      start: (message: string, epoch: number) =>
        Effect.suspend(() => {
          const previousEpoch = assignmentEpoch;
          return supervisor.setAssignmentEpoch(epoch).pipe(
            Effect.mapError(supervisorError("start")),
            Effect.andThen(currentThread),
            Effect.tap(() =>
              Effect.sync(() => {
                assignmentEpoch = epoch;
              }),
            ),
            Effect.flatMap((currentThreadId) =>
              rpcResult(
                (id) =>
                  turnStartRequest(
                    id,
                    currentThreadId,
                    message,
                    request.model,
                    request.effort,
                    sandboxPolicy,
                    request.openaiFastMode,
                  ),
                TurnStartResult,
                "turn/start",
              ),
            ),
            Effect.flatMap((started) => markTurnStarted(started.turn.id, epoch)),
            Effect.tapError((error) =>
              Effect.sync(() => {
                const uncertain =
                  Predicate.isTagged(error, "SubagentProcessError") && isOutcomeUncertain(error);
                if (!uncertain && !activeTurnId && assignmentEpoch === epoch)
                  assignmentEpoch = previousEpoch;
              }),
            ),
          );
        }),
      steer: (message: string) =>
        activeTurn.pipe(
          Effect.flatMap(({ threadId: currentThreadId, turnId }) =>
            rpcResult(
              (id) => turnSteerRequest(id, currentThreadId, turnId, message),
              TurnSteerResult,
              "turn/steer",
            ).pipe(
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
      interrupt: activeTurn.pipe(
        Effect.flatMap(({ threadId: currentThreadId, turnId }) =>
          interrupts.run({
            make: (base) => ({ ...base, turnId }),
            respond: () =>
              rpcResult(
                (id) => turnInterruptRequest(id, currentThreadId, turnId),
                EmptyObject,
                "turn/interrupt",
              ),
            timeoutMessage:
              "Codex interrupt did not receive both its correlated JSON-RPC response and matching interrupted turn completion.",
          }),
        ),
      ),
    },
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

export const localCodexBackendDriver = localCliBackendDriver(
  "codex",
  (capability) =>
    `Local Codex app-server does not expose ${capability} in the hardened protocol subset.`,
  makeLocalCodexHandle,
);
