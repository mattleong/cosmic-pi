import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
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
  UnsupportedSubagentCapabilityError,
  type SubagentError,
} from "../run/errors.ts";
import type { BackendDriver, BackendEvent, BackendLaunchRequest } from "./model.ts";
import { withLocalSupervisorInstructions } from "./local-supervisor-prompt.ts";
import {
  CLAUDE_INTERRUPT_MARKER,
  CLAUDE_SUPERVISOR_SERVER_NAME,
  CLAUDE_SUPERVISOR_TOOL_NAMES,
  claudeInitializeFrame,
  claudeInterruptFrame,
  claudeMcpStatusFrame,
  claudeUserFrame,
  decodeClaudeInitializeControlResponse,
  decodeClaudeMcpStatusControlResponse,
  decodeClaudeProtocolEvent,
  type ClaudeNativeInitialization,
} from "./local-claude-protocol.ts";

const EVENT_CAPACITY = 512;
const CONTROL_TIMEOUT = "10 seconds";
const MCP_READY_ATTEMPTS = 100;
const INITIALIZATION_PROBE = "pi-subagents native initialization probe";

const processError = (operation: string, code: string, message: string) =>
  new SubagentProcessError({ operation, code, message });

const unsupported = (capability: string) =>
  new UnsupportedSubagentCapabilityError({
    backend: "local/claude",
    capability,
    message: `Local Claude Code does not provide a confirmable ${capability} operation.`,
  });

interface PendingUserReplay {
  readonly text: string;
  readonly epoch: number;
  readonly emitRunStarted: boolean;
  readonly acknowledgement: Deferred.Deferred<void, SubagentError>;
}

interface PendingControl {
  readonly operation: string;
  readonly deferred: Deferred.Deferred<unknown, SubagentError>;
}

interface PendingInterrupt {
  readonly requestId: string;
  readonly epoch: number;
  readonly response: Deferred.Deferred<unknown, SubagentError>;
  readonly terminal: Deferred.Deferred<void, SubagentError>;
  markerSeen: boolean;
  resultSeen: boolean;
}

const makeLocalClaudeHandle = Effect.fn("LocalClaudeBackend.makeHandle")(function* (
  request: BackendLaunchRequest,
  child: LocalCliHandle,
  supervisor: SupervisorChannelHandle,
) {
  const events = yield* Queue.bounded<BackendEvent, Cause.Done>(EVENT_CAPACITY);
  const rawOwners = new Map<BackendEvent, LocalCliWireEvent>();
  const controlResponses = new Map<string, PendingControl>();
  const nativeInitialization = Deferred.makeUnsafe<ClaudeNativeInitialization, SubagentError>();
  const toolNames = new Map<string, string>();
  let pendingUserReplay: PendingUserReplay | undefined;
  let pendingInterrupt: PendingInterrupt | undefined;
  let assignmentEpoch = 0;
  let nextControlId = 1;
  let initializationStarted = false;
  let nativeSessionId: string | undefined;

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
    if (pendingUserReplay) {
      Deferred.doneUnsafe(pendingUserReplay.acknowledgement, Effect.fail(error));
      pendingUserReplay = undefined;
    }
    for (const pending of controlResponses.values())
      Deferred.doneUnsafe(pending.deferred, Effect.fail(error));
    controlResponses.clear();
    Deferred.doneUnsafe(nativeInitialization, Effect.fail(error));
    if (pendingInterrupt) {
      Deferred.doneUnsafe(pendingInterrupt.terminal, Effect.fail(error));
      pendingInterrupt = undefined;
    }
    toolNames.clear();
    supervisor.cancelPending(error.message);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      cancelPending(
        processError("close", "local_claude_closed", "Local Claude Code backend closed."),
      );
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

  const consumeRaw = (raw: LocalCliWireEvent): Effect.Effect<void> => {
    if (raw.type === "protocol_error")
      return offer({ type: "protocol_error", message: raw.message }, raw);
    if (raw.type === "exit") {
      child.acknowledge(raw);
      return Effect.void;
    }
    return decodeClaudeProtocolEvent(raw.value).pipe(
      Effect.flatMap((event) => {
        switch (event.type) {
          case "ignored":
            child.acknowledge(raw);
            return Effect.void;
          case "init":
            nativeSessionId = event.sessionId;
            Deferred.doneUnsafe(nativeInitialization, Effect.succeed(event));
            child.acknowledge(raw);
            return Effect.void;
          case "activity":
            return offer({ type: "activity", assignmentEpoch }, raw);
          case "user": {
            const pending = pendingUserReplay;
            if (
              pending &&
              event.isReplay &&
              pending.text === event.text &&
              (event.sessionId === undefined ||
                nativeSessionId === undefined ||
                event.sessionId === nativeSessionId)
            ) {
              pendingUserReplay = undefined;
              Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
              return pending.emitRunStarted
                ? offer({ type: "run_started", assignmentEpoch: pending.epoch }, raw)
                : Effect.sync(() => child.acknowledge(raw));
            }
            const interrupt = pendingInterrupt;
            if (
              interrupt &&
              interrupt.epoch === assignmentEpoch &&
              event.isReplay &&
              event.text === CLAUDE_INTERRUPT_MARKER &&
              event.toolResults.length === 0
            ) {
              interrupt.markerSeen = true;
              if (interrupt.resultSeen) Deferred.doneUnsafe(interrupt.terminal, Effect.void);
              child.acknowledge(raw);
              return Effect.void;
            }
            if (event.toolResults.length > 0)
              return Effect.gen(function* () {
                for (const [index, result] of event.toolResults.entries()) {
                  const name = toolNames.get(result.id) ?? "ClaudeTool";
                  toolNames.delete(result.id);
                  yield* offer(
                    {
                      type: "tool_finished",
                      assignmentEpoch,
                      toolCallId: result.id,
                      toolName: name,
                      isError: result.isError,
                    },
                    index === event.toolResults.length - 1 ? raw : undefined,
                  );
                }
              });
            return offer(
              {
                type: "protocol_error",
                message: "Claude replayed an uncorrelated stream-input message.",
              },
              raw,
            );
          }
          case "control_response": {
            const pending = controlResponses.get(event.requestId);
            if (!pending) {
              child.acknowledge(raw);
              return Effect.void;
            }
            controlResponses.delete(event.requestId);
            Deferred.doneUnsafe(
              pending.deferred,
              event.success
                ? Effect.succeed(event.response)
                : Effect.fail(
                    processError(
                      pending.operation,
                      `${pending.operation}_rejected`,
                      event.diagnostic ?? `Claude Code rejected ${pending.operation}.`,
                    ),
                  ),
            );
            child.acknowledge(raw);
            return Effect.void;
          }
          case "assistant":
            return Effect.gen(function* () {
              for (const tool of event.tools) {
                toolNames.set(tool.id, tool.name);
                yield* offer({
                  type: "tool_started",
                  assignmentEpoch,
                  toolCallId: tool.id,
                  toolName: tool.name,
                  args: tool.input,
                });
              }
              yield* offer(
                {
                  type: "assistant_message",
                  assignmentEpoch,
                  ...(event.text ? { text: event.text } : {}),
                  usage: event.usage,
                },
                raw,
              );
            });
          case "result": {
            const interrupt = pendingInterrupt;
            const expectedInterruptedResult =
              interrupt !== undefined &&
              interrupt.epoch === assignmentEpoch &&
              event.isError &&
              event.subtype === "error_during_execution" &&
              event.stopReason === "aborted_streaming" &&
              (event.sessionId === undefined ||
                nativeSessionId === undefined ||
                event.sessionId === nativeSessionId);
            if (expectedInterruptedResult) {
              interrupt.resultSeen = true;
              if (interrupt.markerSeen) Deferred.doneUnsafe(interrupt.terminal, Effect.void);
              child.acknowledge(raw);
              return Effect.void;
            }
            if (event.isError)
              return offer(
                {
                  type: "protocol_error",
                  message: event.diagnostic
                    ? `Claude Code result failed: ${event.diagnostic}`
                    : "Claude Code result failed before a supervisor report was accepted.",
                },
                raw,
              );
            // Epoch zero is the shouldQuery:false native initialization probe. Assignment results
            // may be acknowledged only after the MCP report call recorded causal acceptance.
            if (assignmentEpoch === 0) return Effect.sync(() => child.acknowledge(raw));
            const completedEpoch = assignmentEpoch;
            return supervisor.hasAcceptedReport(completedEpoch).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  offer(
                    {
                      type: "protocol_error",
                      message: `Unable to confirm Claude supervisor report ownership: ${error.message}`,
                    },
                    raw,
                  ),
                onSuccess: (accepted) =>
                  accepted
                    ? Effect.sync(() => child.acknowledge(raw))
                    : offer(
                        {
                          type: "protocol_error",
                          message:
                            "Claude Code result completed without an accepted supervisor report.",
                        },
                        raw,
                      ),
              }),
            );
          }
        }
      }),
      Effect.catch(() =>
        offer(
          { type: "protocol_error", message: "Claude Code emitted an invalid stream event." },
          raw,
        ),
      ),
    );
  };

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeRaw),
    Effect.catchCause(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() => {
        cancelPending(
          processError(
            "run",
            "local_claude_transport_closed",
            "Local Claude Code transport closed.",
          ),
        );
        Queue.endUnsafe(events);
      }),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromQueue(supervisor.events).pipe(
    Stream.runForEach((event) => offer(event)),
    Effect.catchCause(() => Effect.void),
    Effect.forkScoped,
  );

  const failUncertainDelivery = <A>(error: SubagentError): Effect.Effect<A, SubagentError> =>
    child.terminate("force").pipe(
      Effect.catch(() => Effect.void),
      Effect.andThen(Effect.fail(error)),
    );

  const sendUser = (
    text: string,
    epoch: number,
    operation: "initialize" | "start" | "steer",
    shouldQuery = true,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (pendingUserReplay)
          return {
            pending: undefined,
            error: processError(
              operation,
              `${operation}_not_sent`,
              "Another Claude stream-input delivery is awaiting native replay confirmation.",
            ),
          } as const;
        const pending: PendingUserReplay = {
          text,
          epoch,
          emitRunStarted: operation === "start",
          acknowledgement: Deferred.makeUnsafe<void, SubagentError>(),
        };
        pendingUserReplay = pending;
        return { pending } as const;
      }),
      (acquired) => {
        if (!("pending" in acquired) || !acquired.pending) return Effect.fail(acquired.error);
        return child.send(claudeUserFrame(text, { shouldQuery })).pipe(
          Effect.mapError((error) =>
            error.code === "transport_outcome_uncertain"
              ? processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  `Claude stream input may already have been accepted; inspect run status before retrying. (${error.message})`,
                )
              : error,
          ),
          Effect.catch((error) =>
            error instanceof SubagentProcessError && error.code?.endsWith("_outcome_uncertain")
              ? failUncertainDelivery(error)
              : Effect.fail(error),
          ),
          Effect.andThen(Deferred.await(acquired.pending.acknowledgement)),
          Effect.timeoutOption(CONTROL_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.void
              : failUncertainDelivery(
                  processError(
                    operation,
                    `${operation}_outcome_uncertain`,
                    "Claude stream input was sent but native replay confirmation did not arrive; the backend was closed to prevent ambiguous retry correlation.",
                  ),
                ),
          ),
        );
      },
      (acquired) =>
        Effect.sync(() => {
          if ("pending" in acquired && pendingUserReplay === acquired.pending)
            pendingUserReplay = undefined;
        }),
    );

  const requestControl = (
    operation: string,
    makeFrame: (requestId: string) => Readonly<Record<string, unknown>>,
  ): Effect.Effect<unknown, SubagentError> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const requestId = `${operation}-${nextControlId++}`;
        const deferred = Deferred.makeUnsafe<unknown, SubagentError>();
        controlResponses.set(requestId, { operation, deferred });
        return { requestId, deferred };
      }),
      ({ requestId, deferred }) =>
        child.send(makeFrame(requestId)).pipe(
          Effect.mapError((error) =>
            error.code === "transport_outcome_uncertain"
              ? processError(
                  operation,
                  `${operation}_outcome_uncertain`,
                  `Claude ${operation} may already have applied; it will not be retried. (${error.message})`,
                )
              : error,
          ),
          Effect.andThen(Deferred.await(deferred)),
          Effect.timeoutOption(CONTROL_TIMEOUT),
          Effect.flatMap((outcome) =>
            Option.isSome(outcome)
              ? Effect.succeed(outcome.value)
              : Effect.fail(
                  processError(
                    operation,
                    `${operation}_outcome_uncertain`,
                    `Claude ${operation} was sent but no correlated native response arrived; it will not be retried.`,
                  ),
                ),
          ),
        ),
      ({ requestId }) => Effect.sync(() => void controlResponses.delete(requestId)),
    );

  const initialize = Effect.gen(function* () {
    if (initializationStarted)
      return yield* processError(
        "initialize",
        "claude_initialize_repeated",
        "Claude Code initialization may only be performed once per backend handle.",
      );
    initializationStarted = true;
    const response = yield* requestControl("initialize", claudeInitializeFrame);
    const advertised = yield* decodeClaudeInitializeControlResponse(response).pipe(
      Effect.mapError(() =>
        processError(
          "initialize",
          "claude_initialize_invalid",
          "Claude Code returned an invalid initialize control response.",
        ),
      ),
    );
    yield* sendUser(INITIALIZATION_PROBE, 0, "initialize", false);
    const native = yield* Deferred.await(nativeInitialization).pipe(
      Effect.timeoutOption(CONTROL_TIMEOUT),
      Effect.flatMap((outcome) =>
        Option.isSome(outcome)
          ? Effect.succeed(outcome.value)
          : Effect.fail(
              processError(
                "initialize",
                "claude_native_init_missing",
                "Claude Code did not emit its mandatory native system/init event.",
              ),
            ),
      ),
    );
    const resolvedModel =
      advertised.models.find((model) => model.value === request.model)?.resolvedModel ??
      request.model;
    if (native.model !== request.model && native.model !== resolvedModel)
      return yield* processError(
        "initialize",
        "claude_model_mismatch",
        `Claude Code selected model ${native.model} instead of required model ${request.model}.`,
      );
    if (native.cwd !== request.cwd)
      return yield* processError(
        "initialize",
        "claude_cwd_mismatch",
        "Claude Code initialized outside the canonical assigned working directory.",
      );
    if (!native.sessionId || native.hasMcpServerErrors)
      return yield* processError(
        "initialize",
        "claude_native_init_invalid",
        native.hasMcpServerErrors
          ? "Claude Code rejected part of the mandatory private MCP configuration."
          : "Claude Code did not provide a native session identity.",
      );

    let supervisorReady = false;
    for (let attempt = 0; attempt < MCP_READY_ATTEMPTS; attempt += 1) {
      const status = yield* requestControl("mcp_status", claudeMcpStatusFrame).pipe(
        Effect.flatMap((value) =>
          decodeClaudeMcpStatusControlResponse(value).pipe(
            Effect.mapError(() =>
              processError(
                "initialize",
                "claude_mcp_status_invalid",
                "Claude Code returned an invalid mandatory MCP status response.",
              ),
            ),
          ),
        ),
      );
      const server = status.mcpServers.find(
        (candidate) => candidate.name === CLAUDE_SUPERVISOR_SERVER_NAME,
      );
      if (server?.status === "connected") {
        const inventory = new Set(server.tools?.map((tool) => tool.name) ?? []);
        if (CLAUDE_SUPERVISOR_TOOL_NAMES.every((tool) => inventory.has(tool))) {
          supervisorReady = true;
          break;
        }
        return yield* processError(
          "initialize",
          "claude_supervisor_tools_missing",
          "Claude Code connected the private supervisor MCP server without its mandatory tool inventory.",
        );
      }
      if (server && server.status !== "pending" && server.status !== "connecting") break;
      yield* Effect.sleep("50 millis");
    }
    if (!supervisorReady)
      return yield* processError(
        "initialize",
        "claude_supervisor_mcp_unavailable",
        "Claude Code did not connect the mandatory pi_subagents_supervisor MCP server.",
      );
    return {
      model: native.model,
      effort: request.effort,
      sessionId: native.sessionId,
    };
  });

  const interrupt = Effect.acquireUseRelease(
    Effect.sync(() => {
      if (pendingInterrupt)
        return {
          lifecycle: undefined,
          error: processError(
            "interrupt",
            "interrupt_not_sent",
            "Another Claude interrupt lifecycle is already pending.",
          ),
        } as const;
      const requestId = `interrupt-${nextControlId++}`;
      const lifecycle: PendingInterrupt = {
        requestId,
        epoch: assignmentEpoch,
        response: Deferred.makeUnsafe<unknown, SubagentError>(),
        terminal: Deferred.makeUnsafe<void, SubagentError>(),
        markerSeen: false,
        resultSeen: false,
      };
      pendingInterrupt = lifecycle;
      controlResponses.set(requestId, { operation: "interrupt", deferred: lifecycle.response });
      return { lifecycle } as const;
    }),
    (acquired) => {
      if (!acquired.lifecycle) return Effect.fail(acquired.error);
      const lifecycle = acquired.lifecycle;
      const response = child.send(claudeInterruptFrame(lifecycle.requestId)).pipe(
        Effect.mapError((error) =>
          error.code === "transport_outcome_uncertain"
            ? processError(
                "interrupt",
                "interrupt_outcome_uncertain",
                `Claude interrupt may already have applied; it will not be retried. (${error.message})`,
              )
            : error,
        ),
        Effect.andThen(Deferred.await(lifecycle.response)),
      );
      return Effect.all([response, Deferred.await(lifecycle.terminal)], {
        concurrency: "unbounded",
        discard: true,
      }).pipe(
        Effect.timeoutOption(CONTROL_TIMEOUT),
        Effect.flatMap((outcome) =>
          Option.isSome(outcome)
            ? Effect.void
            : Effect.fail(
                processError(
                  "interrupt",
                  "interrupt_outcome_uncertain",
                  "Claude interrupt did not complete its correlated response, replay marker, and aborted result lifecycle; it will not be retried.",
                ),
              ),
        ),
      );
    },
    (acquired) =>
      Effect.sync(() => {
        if (!acquired.lifecycle) return;
        controlResponses.delete(acquired.lifecycle.requestId);
        if (pendingInterrupt === acquired.lifecycle) pendingInterrupt = undefined;
      }),
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
        supervisor.setAssignmentEpoch(epoch).pipe(
          Effect.mapError((error) => processError("start", error.code, error.message)),
          Effect.andThen(
            Effect.sync(() => {
              assignmentEpoch = epoch;
            }),
          ),
          Effect.andThen(sendUser(message, epoch, "start")),
        ),
      steer: (message: string) => sendUser(message, assignmentEpoch, "steer"),
      interrupt,
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

export const makeLocalClaudeBackendDriver = (
  processes: LocalCliProcessShape,
  supervisors: SupervisorChannelShape,
): BackendDriver => ({
  host: "local",
  runtime: "claude",
  capabilities: ["steer", "interrupt", "parent-contact"],
  supportsContext: (context) => context === "fresh",
  preflight: (request) => processes.preflight({ runtime: "claude", ...request }),
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
        runtime: "claude",
        launch,
        supervisor: supervisor.metadata,
      });
      return yield* makeLocalClaudeHandle(launch, child, supervisor);
    }),
});

export const localClaudeBackendDriver = Effect.gen(function* () {
  const processes = yield* LocalCliProcess;
  const supervisors = yield* SupervisorChannel;
  return makeLocalClaudeBackendDriver(processes, supervisors);
});
