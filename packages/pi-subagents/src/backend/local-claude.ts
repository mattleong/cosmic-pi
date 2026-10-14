import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { LocalCliProcessHandle } from "../boundary/local-cli-process.ts";
import type { LocalClaudeDebugEntry } from "../boundary/local-claude-debug.ts";
import type { LocalCliWireEvent } from "../boundary/local-cli-transport.ts";
import type { SupervisorChannelHandle } from "../boundary/supervisor-channel.ts";
import { processError, type SubagentError } from "../run/errors.ts";
import type { SupervisorEvent } from "../supervisor/protocol.ts";
import { localCliInterrupts } from "./local-cli-interruption.ts";
import { toBackendExit, type BackendLaunchRequest, type BackendReport } from "./model.ts";
import type {
  LocalClaudeHandleContext,
  LocalClaudeHandleState,
  PendingInterrupt,
} from "./local-claude-context.ts";
import { localClaudeControl, type ClaudeInitProtocolEvent } from "./local-claude-control.ts";
import { isSameClaudeSession, claudeResultCorrelation } from "./local-claude-correlation.ts";
import { localClaudeInputDelivery } from "./local-claude-input-delivery.ts";
import { localClaudeReportDelivery } from "./local-claude-report-delivery.ts";
import { localClaudeResults } from "./local-claude-results.ts";
import { localClaudeDiagnostics } from "./local-claude-diagnostics.ts";
import { localClaudeUsage, usageComponentsTotal } from "./local-claude-usage.ts";
import { localClaudeUserEvents } from "./local-claude-user-events.ts";
import { localCliEventIngress } from "./local-cli-events.ts";
import { supervisorError } from "./driver-shared.ts";
import { deliverTerminalReport, localCliBackendDriver } from "./local-cli-driver.ts";
import { CLAUDE_NATIVE_AGENT_TOOLS } from "./claude-policy.ts";
import {
  claudeInterruptFrame,
  decodeClaudeProtocolEvent,
  type ClaudeProtocolEvent,
} from "./local-claude-protocol.ts";

const CLAUDE_NATIVE_AGENT_START_TOOLS: ReadonlySet<string> = new Set(["Agent", "Task"]);
const CLAUDE_NATIVE_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set(CLAUDE_NATIVE_AGENT_TOOLS);

type ClaudeAssistantProtocolEvent = Extract<ClaudeProtocolEvent, { readonly type: "assistant" }>;

const makeLocalClaudeHandle = Effect.fn("LocalClaudeBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliProcessHandle,
  supervisor: SupervisorChannelHandle,
) {
  const scope = yield* Scope.Scope;
  const { events, offer, release, acknowledge } = yield* localCliEventIngress(child.acknowledge);
  const nativeInitialization = Deferred.makeUnsafe<ClaudeInitProtocolEvent, SubagentError>();
  const toolNames = new Map<string, string>();
  const nativeToolNames = new Map<string, string>();
  const correlation = claudeResultCorrelation();
  const usage = localClaudeUsage();
  const reports = localClaudeReportDelivery(offer);
  const handleState: LocalClaudeHandleState = {
    assignmentEpoch: 0,
    nativeSessionId: undefined,
    lastOutboundAtMillis: undefined,
    backgroundTasks: 0,
    topLevelTaskIds: new Set<string>(),
    notificationSinceResult: false,
    continuationActivity: false,
    continuationToken: 0,
    awaitingContinuationEpoch: undefined,
  };
  const interrupts = localCliInterrupts<PendingInterrupt>(
    "Claude",
    { offer, release },
    () => handleState.assignmentEpoch,
  );
  let wireSequence = 0;

  const recordDebug = child.claudeDebug?.record ?? ((_entry: LocalClaudeDebugEntry) => Effect.void);
  const nextWireSequence = (): number => {
    wireSequence += 1;
    return wireSequence;
  };

  const diagnostics = localClaudeDiagnostics(() => [
    ...toolNames.values(),
    ...nativeToolNames.values(),
  ]);
  const inputs = localClaudeInputDelivery(
    child,
    scope,
    (operation, epoch, shouldQuery) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((nowMillis) => {
          handleState.lastOutboundAtMillis = nowMillis;
          return recordDebug({
            kind: "outbound-user",
            sequence: nextWireSequence(),
            operation,
            epoch,
            shouldQuery,
          });
        }),
      ),
    {
      onState: (input, state) =>
        offer({
          type: "input_delivery",
          assignmentEpoch: input.epoch,
          sequence: input.sequence,
          state,
        }),
      diagnose: diagnostics.diagnose,
      onFailure: (error) => offer({ type: "backend_failure", error }),
      preserveReport: (epoch): Effect.Effect<boolean> =>
        supervisor.acceptedReportForEpoch(epoch).pipe(
          Effect.flatMap((report) =>
            report?.assignmentEpoch === epoch
              ? forwardAcceptedReport(report).pipe(Effect.as(true))
              : Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => false),
        ),
    },
  );
  const forwardAcceptedReport = (report: BackendReport) =>
    inputs
      .acceptReport(report.assignmentEpoch)
      .pipe(Effect.andThen(reports.forwardReport({ type: "report", ...report })));

  const context: LocalClaudeHandleContext = {
    state: handleState,
    child,
    supervisor,
    offer,
    release,
    correlation,
    usage,
    reports,
    interrupts,
    inputs,
    recordDebug,
    forwardAcceptedReport,
    toolNames,
    nativeToolNames,
    forkOwned: (effect) =>
      Effect.forkIn(effect, scope, { startImmediately: true }).pipe(Effect.asVoid),
  };
  const control = localClaudeControl(request, context, nativeInitialization);
  const { onUser } = localClaudeUserEvents(context);
  const { onResult, onBackgroundTasksSettled } = localClaudeResults(context);

  const cancelPending = (error: SubagentError) => {
    inputs.cancel(error);
    control.cancel(error);
    Deferred.doneUnsafe(nativeInitialization, Effect.fail(error));
    interrupts.cancel(error);
    toolNames.clear();
    nativeToolNames.clear();
    correlation.clear();
    usage.clearMessageHistory();
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() =>
      cancelPending(
        processError("close", "local_claude_closed", "Local Claude Code backend closed."),
      ),
    ),
  );

  const handleSupervisorEvent = (event: SupervisorEvent) =>
    event.type === "report"
      ? inputs
          .acceptReport(event.assignmentEpoch)
          .pipe(
            Effect.flatMap((unconfirmed) =>
              unconfirmed ? reports.forwardReport(event) : reports.bufferAcceptedReport(event),
            ),
          )
      : offer(event);

  const onInit = (event: ClaudeInitProtocolEvent, raw: LocalCliWireEvent): Effect.Effect<void> => {
    handleState.nativeSessionId = event.sessionId;
    Deferred.doneUnsafe(nativeInitialization, Effect.succeed(event));
    return release(raw);
  };

  const onAssistant = (event: ClaudeAssistantProtocolEvent, raw: LocalCliWireEvent) =>
    Effect.gen(function* () {
      if (event.parentToolUseId === undefined) handleState.continuationActivity = true;
      for (const tool of event.tools) {
        if (CLAUDE_NATIVE_AGENT_TOOL_NAMES.has(tool.name)) {
          nativeToolNames.set(tool.id, tool.name);
          yield* offer({
            type: "native_agent_activity",
            assignmentEpoch: handleState.assignmentEpoch,
            activityId: tool.id,
            kind: tool.name,
            state: CLAUDE_NATIVE_AGENT_START_TOOLS.has(tool.name) ? "running" : "completed",
          });
          continue;
        }
        toolNames.set(tool.id, tool.name);
        yield* offer({
          type: "tool_started",
          assignmentEpoch: handleState.assignmentEpoch,
          toolCallId: tool.id,
          toolName: tool.name,
          args: tool.input,
        });
      }
      const { delta, inconsistent } = usage.assistantDelta(event.messageId, event.usage);
      if (inconsistent)
        yield* offer({
          type: "warning",
          message:
            "Claude reported a regressing cumulative assistant usage total; accounting stays monotone and the regression was ignored.",
        });
      yield* offer(
        {
          type: "assistant_message" as const,
          assignmentEpoch: handleState.assignmentEpoch,
          ...(event.text !== undefined && event.text.length > 0 && { text: event.text }),
          usage: { ...delta, totalTokens: usageComponentsTotal(delta) },
        },
        raw,
      );
    });

  const consumeRaw = (raw: LocalCliWireEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      const sequence = nextWireSequence();
      if (raw.type === "protocol_error")
        return diagnostics
          .observe("protocol-error")
          .pipe(Effect.andThen(offer({ type: "protocol_error", message: raw.message }, raw)));
      return decodeClaudeProtocolEvent(raw.value).pipe(
        Effect.flatMap((event) => {
          const recordInbound =
            event.type === "activity" || event.type === "ignored"
              ? Effect.void
              : recordDebug({
                  kind: "inbound",
                  sequence,
                  protocolType: event.type,
                  epoch: handleState.assignmentEpoch,
                });
          return diagnostics
            .observe(event.type, event.type === "init" ? event.cliVersion : undefined)
            .pipe(
              Effect.andThen(recordInbound),
              Effect.andThen(
                ((): Effect.Effect<void> => {
                  switch (event.type) {
                    case "ignored":
                      return release(raw);
                    case "init":
                      return onInit(event, raw);
                    case "activity":
                      return offer(
                        { type: "activity", assignmentEpoch: handleState.assignmentEpoch },
                        raw,
                      );
                    case "background_tasks": {
                      if (!isSameClaudeSession(event.sessionId, handleState.nativeSessionId))
                        return release(raw);
                      const wasRunning = handleState.backgroundTasks > 0;
                      handleState.backgroundTasks = event.taskIds.length;
                      for (const taskId of event.taskIds)
                        if (handleState.topLevelTaskIds.size < MAX_TRACKED_BACKGROUND_TASKS)
                          handleState.topLevelTaskIds.add(taskId);
                      return (
                        wasRunning && event.taskIds.length === 0
                          ? onBackgroundTasksSettled()
                          : Effect.void
                      ).pipe(
                        Effect.andThen(
                          offer(
                            { type: "activity", assignmentEpoch: handleState.assignmentEpoch },
                            raw,
                          ),
                        ),
                      );
                    }
                    case "task_notification":
                      if (
                        isSameClaudeSession(event.sessionId, handleState.nativeSessionId) &&
                        handleState.topLevelTaskIds.has(event.taskId)
                      )
                        handleState.notificationSinceResult = true;
                      return offer(
                        { type: "activity", assignmentEpoch: handleState.assignmentEpoch },
                        raw,
                      );
                    case "user":
                      return onUser(event, raw, sequence);
                    case "control_response":
                      return control.onControlResponse(event, raw);
                    case "assistant":
                      return onAssistant(event, raw);
                    case "result":
                      return onResult(event, raw);
                  }
                  return absurd(event);
                })(),
              ),
            );
        }),
        Effect.catch(() =>
          offer(
            { type: "protocol_error", message: "Claude Code emitted an invalid stream event." },
            raw,
          ),
        ),
      );
    });

  const preserveAcceptedReport = Effect.suspend(() =>
    handleState.assignmentEpoch <= 0
      ? Effect.void
      : supervisor.acceptedReportForEpoch(handleState.assignmentEpoch).pipe(
          Effect.flatMap((report) => (report ? forwardAcceptedReport(report) : Effect.void)),
          Effect.catch(() =>
            offer({
              type: "protocol_error",
              message:
                "Unable to preserve the accepted Claude report before the backend event transport closed.",
            }),
          ),
        ),
  );

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeRaw),
    Effect.ignoreCause,
    Effect.ensuring(
      deliverTerminalReport(
        events,
        preserveAcceptedReport.pipe(
          Effect.ensuring(
            Effect.sync(() =>
              cancelPending(
                processError(
                  "run",
                  "local_claude_transport_closed",
                  "Local Claude Code transport closed.",
                ),
              ),
            ),
          ),
        ),
        scope,
      ),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach(handleSupervisorEvent),
    Effect.ignoreCause,
    Effect.forkScoped,
  );

  const interrupt = interrupts.run({
    blocked: () =>
      inputs.pending || inputs.failure
        ? processError(
            "interrupt",
            "interrupt_not_sent",
            "Claude stream-input acknowledgement remains unresolved; cancel_queued interruption could discard owned guidance. Do not resend; wait or stop the run.",
          )
        : undefined,
    make: (base) => ({
      ...base,
      ...control.interruptRequest(),
      markerSeen: false,
      resultSeen: false,
    }),
    respond: (lifecycle) =>
      control
        .sendControl("interrupt", claudeInterruptFrame(lifecycle.requestId))
        .pipe(Effect.andThen(Deferred.await(lifecycle.response))),
    timeoutMessage:
      "Claude interrupt did not complete its correlated response, replay marker, and aborted result lifecycle; it will not be retried.",
    onRelease: (lifecycle) => control.forget(lifecycle.requestId),
  });

  return {
    pid: child.pid,
    events,
    awaitExit: child.awaitExit.pipe(
      Effect.map((exit) => ({
        ...toBackendExit(exit),
        ...(inputs.failure && { failure: inputs.failure }),
      })),
      Effect.mapError((error) => inputs.failure ?? error),
    ),
    controls: {
      initialize: control.initialize,
      start: (message: string, epoch: number) =>
        supervisor.setAssignmentEpoch(epoch).pipe(
          Effect.mapError(supervisorError("start")),
          Effect.andThen(
            Effect.sync(() => {
              handleState.assignmentEpoch = epoch;
            }),
          ),
          Effect.andThen(inputs.send(message, epoch, "start")),
        ),
      steer: (message: string) => inputs.send(message, handleState.assignmentEpoch, "steer"),
      interrupt,
    },
    acknowledge,
    terminate: child.terminate,
    cancelPending,
  };
});

// Bounds the set of task IDs one Claude process can accumulate.
const MAX_TRACKED_BACKGROUND_TASKS = 1_024;

export const localClaudeBackendDriver = localCliBackendDriver(
  "claude",
  (capability) => `Local Claude Code does not provide a confirmable ${capability} operation.`,
  makeLocalClaudeHandle,
);
