import { FAST_SERVICE_TIER } from "pi-better-openai/fast-models";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { LocalCliHandle, LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
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
  ThreadStartResult,
  threadStartRequest,
  turnInterruptRequest,
  TurnStartResult,
  turnStartRequest,
  turnSteerRequest,
  TurnSteerResult,
  type CodexNotification,
  type CodexRequest,
} from "./local-codex-protocol.ts";
import { makeLocalCliInterrupts, type LocalCliInterrupt } from "./local-cli-interruption.ts";
import { toBackendExit, type BackendLaunchRequest } from "./model.ts";
import { makeLocalCliEventIngress } from "./local-cli-events.ts";
import { correlatedRequest, protocolError, supervisorError } from "./driver-shared.ts";
import { deliverTerminalReport, makeLocalCliBackendDriver } from "./local-cli-driver.ts";

const RPC_TIMEOUT = "10 seconds";

interface PendingResponse {
  readonly method: CodexRequest["method"];
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

/** Completed by the matching interrupted turn completion. */
interface PendingInterrupt extends LocalCliInterrupt {
  readonly turnId: string;
}

const OUTCOME_CODES = new Map<CodexRequest["method"], string>([
  ["turn/start", "start_outcome_uncertain"],
  ["turn/steer", "guidance_outcome_uncertain"],
  ["turn/interrupt", "interrupt_outcome_uncertain"],
]);
const outcomeCode = (method: CodexRequest["method"]): string =>
  OUTCOME_CODES.get(method) ?? `${method.replaceAll("/", "_")}_outcome_uncertain`;

/**
 * Item classification: only known executable item types own a
 * tool_started/tool_finished lifecycle. Reasoning and other informational items
 * surface as activity, forbidden nested-agent/collaboration items stay fatal,
 * and unknown future item types never fabricate tool lifecycle entries.
 */
const EXECUTABLE_ITEM_TOOL_NAMES = new Map<string, string>([
  ["commandExecution", "Bash"],
  ["fileChange", "ApplyPatch"],
  ["webSearch", "WebSearch"],
]);

const executableToolName = (item: {
  readonly type: string;
  readonly server?: string | undefined;
  readonly tool?: string | undefined;
}): string | undefined => {
  if (item.type === "mcpToolCall")
    return `mcp:${item.server ?? "unknown"}/${item.tool ?? "unknown"}`;
  return EXECUTABLE_ITEM_TOOL_NAMES.get(item.type);
};

type CodexUsage = Extract<CodexNotification, { readonly type: "usage" }>;
type CodexItemEvent = Extract<CodexNotification, { type: "item_started" | "item_completed" }>;
type CodexTurnCompleted = Extract<CodexNotification, { readonly type: "turn_completed" }>;

const makeLocalCodexHandle = Effect.fn("LocalCodexBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliHandle,
  supervisor: SupervisorChannelHandle,
) {
  const scope = yield* Scope.Scope;
  const { events, offer, release, acknowledge } = yield* makeLocalCliEventIngress(
    child.acknowledge,
  );
  const responses = new Map<string, PendingResponse>();
  let nextRequestId = 1;
  let assignmentEpoch = 0;
  let threadId: string | undefined;
  let sessionId: string | undefined;
  let activeTurnId: string | undefined;
  let runStartedTurnId: string | undefined;
  const interrupts = makeLocalCliInterrupts<PendingInterrupt>(
    "Codex",
    { offer, release },
    () => assignmentEpoch,
  );
  let cumulativeUsage: SubagentUsage = emptyUsage();

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
    // Nonnegative per-turn delta over the cumulative totals; Codex reports no
    // client-side cost, so it remains unknown rather than a known $0.
    const delta: SubagentUsage = {
      input: Math.max(0, event.total.inputTokens - cumulativeUsage.input),
      output: Math.max(0, event.total.outputTokens - cumulativeUsage.output),
      cacheRead: Math.max(0, event.total.cachedInputTokens - cumulativeUsage.cacheRead),
      cacheWrite: Math.max(
        0,
        (event.total.cacheWriteInputTokens ?? 0) - cumulativeUsage.cacheWrite,
      ),
      totalTokens: Math.max(0, event.total.totalTokens - cumulativeUsage.totalTokens),
    };
    cumulativeUsage = {
      input: event.total.inputTokens,
      output: event.total.outputTokens,
      cacheRead: event.total.cachedInputTokens,
      cacheWrite: event.total.cacheWriteInputTokens ?? 0,
      totalTokens: event.total.totalTokens,
    };
    return offer({ type: "assistant_message", assignmentEpoch, usage: delta }, raw);
  };

  const onItemStarted = (event: CodexItemEvent, raw: LocalCliWireEvent) => {
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
          event.item.type === "fileChange"
            ? { changes: event.item.changes ?? [] }
            : (event.item.arguments ?? (event.item.command ? { command: event.item.command } : {})),
      },
      raw,
    );
  };

  const onItemCompleted = (event: CodexItemEvent, raw: LocalCliWireEvent) => {
    if (event.item.type === "agentMessage")
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
    const tool = executableToolName(event.item);
    if (tool === undefined)
      // Completion of an informational or unknown item is acknowledged
      // without a fabricated tool_finished, matching item_started.
      return release(raw);
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
  };

  const markTurnStarted = (turnId: string, epoch: number, raw?: LocalCliWireEvent) => {
    activeTurnId = turnId;
    if (runStartedTurnId === turnId) return raw ? release(raw) : Effect.void;
    runStartedTurnId = turnId;
    return offer({ type: "run_started", assignmentEpoch: epoch }, raw);
  };

  const onTurnCompleted = (event: CodexTurnCompleted, raw: LocalCliWireEvent) => {
    const completedEpoch = assignmentEpoch;
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
      Effect.matchEffect({
        onFailure: (error) =>
          offer(
            {
              type: "protocol_error",
              message: `Unable to confirm Codex supervisor report ownership: ${error.message}`,
            },
            raw,
          ),
        onSuccess: (accepted) =>
          accepted
            ? release(raw)
            : offer(
                {
                  type: "protocol_error",
                  message: "Codex turn completed without an accepted supervisor report.",
                },
                raw,
              ),
      }),
    );
  };

  const consumeNotification = <ParamsInput>(
    raw: LocalCliWireEvent,
    method: string,
    params: ParamsInput,
  ) =>
    decodeCodexNotification(method, params).pipe(
      Effect.flatMap((event) => {
        if (event.type === "ignored") return release(raw);
        if (event.type === "warning")
          return offer({ type: "warning", message: event.message }, raw);
        if ("threadId" in event && threadId && event.threadId !== threadId) return release(raw);
        // Every steerable notification carries a turn id; only turn_started may open one.
        if ("turnId" in event && event.type !== "turn_started" && event.turnId !== activeTurnId)
          return release(raw);
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
          case "usage":
            return onUsage(event, raw);
          case "item_started":
            return onItemStarted(event, raw);
          case "item_completed":
            return onItemCompleted(event, raw);
          case "turn_completed":
            return onTurnCompleted(event, raw);
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

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeRaw),
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.sync(() =>
        cancelPending(
          processError("run", "local_codex_transport_closed", "Local Codex transport closed."),
        ),
      ).pipe(Effect.andThen(deliverTerminalReport(events, preserveAcceptedReport, scope))),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach((event) => offer(event)),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const rpc = (makeRequest: (id: string) => CodexRequest): Effect.Effect<unknown, SubagentError> =>
    correlatedRequest({
      timeout: RPC_TIMEOUT,
      register: (deferred) => {
        const request = makeRequest(`codex-${nextRequestId++}`);
        responses.set(request.id, { method: request.method, deferred });
        return {
          frame: request,
          unregister: Effect.sync(() => void responses.delete(request.id)),
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

  /** One correlated request whose result must decode; only decode failure is a protocol error. */
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
    awaitExit: child.awaitExit.pipe(Effect.map(toBackendExit)),
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
                // Runtime notifications can race ahead of the correlated response.
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
                    request.writeIntent,
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
                  error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
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

export const makeLocalCodexBackendDriver = makeLocalCliBackendDriver(
  "codex",
  (capability) =>
    `Local Codex app-server does not expose ${capability} in the hardened protocol subset.`,
  makeLocalCodexHandle,
);
