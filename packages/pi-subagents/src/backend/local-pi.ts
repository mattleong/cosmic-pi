import * as Effect from "effect/Effect";
import { localCliEventIngress } from "./local-cli-events.ts";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Predicate from "effect/Predicate";
import {
  type ChildProcessHandle,
  type ChildProcessContract,
  type ChildWireEvent,
} from "../boundary/child-process.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  processError,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import { PI_SUBAGENT_CAPABILITIES } from "../run/model.ts";
import { localPiUsage } from "./local-pi-usage.ts";
import { requireNodeExecutable } from "../boundary/node-executable.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import {
  decodeRpcEnvelope,
  decodeRpcPromptData,
  decodeRpcStateData,
  oversizedRpcEnvelope,
  rpcStateModelId,
  type RpcChildEnvelope,
} from "./local-pi-protocol.ts";
import {
  normalizeParentContact,
  normalizeRpcEvent,
  parentContactAckOutcome,
} from "./local-pi-events.ts";
import { localPiRpc } from "./local-pi-rpc.ts";
import { MAX_ERROR_CHARS, sanitizeStreamDiagnostic } from "../run/state.ts";
import { oversizedLineError, protocolError } from "./driver-shared.ts";
import {
  toBackendExit,
  type BackendAssistantTerminal,
  type BackendDriver,
  type BackendEvent,
  type BackendLaunchRequest,
  type BackendResumeToken,
} from "./model.ts";

const STARTUP_RPC_TIMEOUT = "30 seconds";
// Pi exits 1 at startup when `--model` names a model no loaded provider offers.
const MODEL_NOT_FOUND = /\bModel "[^"\n]{1,512}" not found\b/u;
const CHILD_EXTENSIONS_REMEDY =
  "Subagents load extensions from Pi settings and installed packages, not from -e. If an extension provides this model, install it with `pi install`.";

const LocalPiResumeToken = Schema.Struct({
  type: Schema.Literal("local-pi-session-file"),
  sessionFile: Schema.String.check(Schema.isMinLength(1)),
});

const localPiResumeToken = (sessionFile: string): typeof LocalPiResumeToken.Type => ({
  type: "local-pi-session-file",
  sessionFile,
});

const decodeLocalPiResumeToken = (token: BackendResumeToken) =>
  Schema.decodeUnknownEffect(LocalPiResumeToken)(token).pipe(
    Effect.mapError(() => protocolError("Local Pi received an invalid backend resume token.")),
  );

const makeLocalPiHandle = Effect.fn("LocalPiBackend.makeHandle")(function* (
  child: ChildProcessHandle,
) {
  const turnControl = yield* Semaphore.make(1);
  const withTurnControl = turnControl.withPermits(1);
  const { rpc, ipcAck, resolveIpcAck, resolveResponse, cancel: cancelPending } = localPiRpc(child);
  let assignmentEpoch = 0;
  let latestTerminal: BackendAssistantTerminal | undefined;
  let transportFailure: SubagentError | undefined;

  const { events, offer, release, acknowledge } = yield* localCliEventIngress(
    child.acknowledge,
    "local-Pi",
  );

  const awaitExit = child.awaitExit.pipe(
    Effect.map((exit) => {
      const stderr = exit.stderr.trim();
      const exited = `Subagent process exited${exit.exitCode === null ? "" : ` with code ${exit.exitCode}`}${exit.signal ? ` (${exit.signal})` : ""}.`;
      const missingModel = MODEL_NOT_FOUND.exec(stderr)?.[0];
      if (!missingModel)
        return {
          ...toBackendExit(exit),
          diagnostic: stderr
            ? `${exited} ${sanitizeStreamDiagnostic(stderr, MAX_ERROR_CHARS - exited.length - 1)}`
            : exited,
        };
      // The remedy follows the first line, which alone becomes the short failure summary.
      const summary = `${exited} ${sanitizeStreamDiagnostic(missingModel, 512)}.\n${CHILD_EXTENSIONS_REMEDY}`;
      const diagnostic = `${summary}\n${sanitizeStreamDiagnostic(stderr, MAX_ERROR_CHARS - summary.length - 1)}`;
      return {
        ...toBackendExit(exit),
        diagnostic,
        failure: new SubagentProcessError({
          operation: "run",
          code: "pi_model_not_found",
          message: diagnostic,
        }),
      };
    }),
    Effect.tapError((error) =>
      Effect.sync(() => {
        transportFailure = error;
        cancelPending(error);
      }),
    ),
  );

  const usageRequests = yield* Queue.dropping<void>(1);
  const accountUsage = localPiUsage();
  const usageControl = yield* Semaphore.make(1);
  const withUsageControl = usageControl.withPermits(1);
  let usageDirty = false;
  let usageReady = false;
  let pendingSettlement: Extract<BackendEvent, { type: "run_settled" }> | undefined;
  // The settlement last handed to the run, until a new child turn makes it stale. Held weakly so
  // the handle never keeps a settled report alive after the run is done with it.
  let offeredSettlement: WeakRef<BackendEvent> | undefined;
  const restartTurn = () => {
    latestTerminal = undefined;
    pendingSettlement = undefined;
    offeredSettlement = undefined;
  };
  const reconcileUsage = Effect.gen(function* () {
    if (transportFailure) return yield* transportFailure;
    const response = yield* rpc({ type: "get_session_stats" });
    const usage = accountUsage.account(response.data);
    if (usage) yield* offer({ type: "usage", usage });
    return undefined;
  });
  const requireUsageBaseline = Effect.suspend(() =>
    accountUsage.hasBaseline()
      ? Effect.void
      : Effect.fail(
          protocolError("Subagent did not provide valid startup usage totals; no prompt was sent."),
        ),
  );
  const drainUsage = Effect.gen(function* () {
    if (!usageReady) return;
    while (usageDirty || pendingSettlement) {
      usageDirty = false;
      const settlement = pendingSettlement;
      yield* Effect.ignore(reconcileUsage);
      if (settlement && settlement === pendingSettlement) {
        pendingSettlement = undefined;
        if (settlement.assignmentEpoch === assignmentEpoch) {
          offeredSettlement = new WeakRef(settlement);
          yield* offer(settlement);
          // The run owns the settled text now; a repeat settlement of this turn needs none.
          if (latestTerminal === settlement.terminal) latestTerminal = undefined;
        }
      }
    }
  });
  const requestUsage = () => {
    usageDirty = true;
    Queue.offerUnsafe(usageRequests, undefined);
  };
  yield* Stream.fromQueue(usageRequests).pipe(
    Stream.runForEach(() => withUsageControl(drainUsage)),
    Effect.forkScoped,
  );

  const consumeEnvelope = (
    envelope: RpcChildEnvelope,
    event: ChildWireEvent,
  ): Effect.Effect<void, Schema.SchemaError> => {
    if (envelope.type === "response") {
      const resolution = resolveResponse(envelope);
      if (resolution === "mismatched")
        return offer(
          {
            type: "protocol_error",
            message: "Subagent returned a mismatched RPC response command.",
          },
          event,
        );
      return release(event);
    }
    if (envelope.type === "extension_ui_request")
      return child
        .send({
          type: "extension_ui_response",
          id: envelope.id,
          cancelled: true,
        })
        .pipe(Effect.ignore, Effect.ensuring(release(event)));
    if (
      envelope.type === "ignored" &&
      ["turn_end", "compaction_end", "entry_appended"].includes(envelope.eventType)
    )
      requestUsage();
    if (
      envelope.type === "agent_start" ||
      (envelope.type === "message_start" && envelope.message.role === "assistant")
    )
      restartTurn();
    const eventAssignmentEpoch = assignmentEpoch;
    return normalizeRpcEvent(envelope, eventAssignmentEpoch).pipe(
      Effect.flatMap((normalized) => {
        if (normalized?.type === "assistant_message") latestTerminal = normalized.terminal;
        if (normalized?.type === "run_settled") {
          pendingSettlement = { ...normalized, terminal: latestTerminal };
          requestUsage();
          return release(event);
        }
        return normalized ? offer(normalized, event) : release(event);
      }),
    );
  };

  const consumeChildEvent = (event: ChildWireEvent): Effect.Effect<void> => {
    if (event.type === "protocol_error")
      return offer({ type: "protocol_error", message: event.message }, event);
    if (event.type === "oversized_line") {
      const envelope = oversizedRpcEnvelope(event);
      return envelope
        ? consumeEnvelope(envelope, event).pipe(
            Effect.catch(() => offer(oversizedLineError("Subagent", event), event)),
          )
        : offer(oversizedLineError("Subagent", event), event);
    }
    if (event.type === "parent_contact") {
      const contact = event.value;
      if (
        contact.type === "parent_reply_ack" ||
        contact.type === "proxy_notification_ack" ||
        contact.type === "turn_input_barrier_ack"
      ) {
        resolveIpcAck(contact.requestId, parentContactAckOutcome(contact));
        return release(event);
      }
      return offer(normalizeParentContact(contact, assignmentEpoch, child), event);
    }
    return decodeRpcEnvelope(event.value).pipe(
      Effect.flatMap((envelope) => consumeEnvelope(envelope, event)),
      Effect.catch(() =>
        offer(
          {
            type: "protocol_error",
            message: "Subagent emitted an invalid protocol event.",
          },
          event,
        ),
      ),
    );
  };

  yield* Stream.fromQueue(child.events).pipe(
    Stream.runForEach(consumeChildEvent),
    Effect.andThen(awaitExit),
    Effect.tap((exit) =>
      Effect.sync(() => {
        transportFailure =
          exit.failure ?? new SubagentProcessError({ operation: "run", message: exit.diagnostic });
        cancelPending(transportFailure);
      }),
    ),
    Effect.ignoreCause,
    Effect.ensuring(
      Effect.gen(function* () {
        transportFailure ??= new SubagentProcessError({
          operation: "run",
          message: "Subagent backend transport closed.",
        });
        cancelPending(transportFailure);
        yield* withUsageControl(drainUsage).pipe(
          Effect.interruptible,
          Effect.ensuring(Effect.sync(() => Queue.endUnsafe(events))),
        );
      }),
    ),
    Effect.forkScoped,
  );

  const controls = {
    initialize: rpc({ type: "get_state" }, STARTUP_RPC_TIMEOUT).pipe(
      Effect.flatMap((response) =>
        decodeRpcStateData(response.data).pipe(
          Effect.mapError(() => protocolError("Subagent returned invalid startup state.")),
        ),
      ),
      Effect.tap(() =>
        withUsageControl(
          reconcileUsage.pipe(
            Effect.andThen(requireUsageBaseline),
            Effect.andThen(
              Effect.sync(() => {
                usageReady = true;
              }),
            ),
          ),
        ),
      ),
      Effect.map((state) => {
        const model = rpcStateModelId(state.model);
        return {
          ...(model && { model }),
          effort: state.thinkingLevel,
          sessionId: state.sessionId,
          ...(state.sessionFile && {
            sessionFile: state.sessionFile,
            resumeToken: localPiResumeToken(state.sessionFile),
          }),
        };
      }),
    ),
    start: (message: string, nextAssignmentEpoch: number) =>
      requireUsageBaseline.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            const previousAssignmentEpoch = assignmentEpoch;
            const previousTerminal = latestTerminal;
            assignmentEpoch = nextAssignmentEpoch;
            latestTerminal = undefined;
            return rpc({ type: "prompt", message }).pipe(
              Effect.flatMap((response) =>
                decodeRpcPromptData(response.data).pipe(
                  Effect.mapError(() =>
                    processError(
                      "start",
                      "prompt_outcome_uncertain",
                      "Subagent did not confirm task admission.\nThe task may already have started; inspect the run with agent_read before retrying.",
                    ),
                  ),
                ),
              ),
              Effect.flatMap(({ disposition }) =>
                disposition === "handled"
                  ? Effect.fail(
                      processError(
                        "start",
                        "prompt_not_delivered",
                        "Subagent did not admit the task.\nAn input hook or slash command handled it before it reached the model.",
                      ),
                    )
                  : Effect.void,
              ),
              Effect.tapError((error) =>
                Effect.sync(() => {
                  const outcomeUncertain =
                    Predicate.isTagged(error, "SubagentProcessError") && isOutcomeUncertain(error);
                  if (!outcomeUncertain && assignmentEpoch === nextAssignmentEpoch) {
                    assignmentEpoch = previousAssignmentEpoch;
                    latestTerminal = previousTerminal;
                  }
                }),
              ),
              Effect.asVoid,
            );
          }),
        ),
      ),
    // A steering prompt queues into a working child and starts a turn in one that has settled, so
    // guidance sent while the run finishes is never left in a queue with no run to consume it.
    steer: (message: string) =>
      withTurnControl(
        rpc({ type: "prompt", message, streamingBehavior: "steer" }).pipe(
          Effect.flatMap((response) =>
            decodeRpcPromptData(response.data).pipe(
              Effect.mapError(() =>
                processError(
                  "deliver guidance to",
                  "guidance_outcome_uncertain",
                  "Subagent returned an unreadable guidance disposition; the guidance may already have applied. Inspect the run with agent_read before retrying.",
                ),
              ),
            ),
          ),
          Effect.flatMap(({ disposition }) => {
            if (disposition === "handled")
              return Effect.fail(
                processError(
                  "deliver guidance to",
                  "guidance_not_delivered",
                  "Subagent handled the guidance before it reached the model, for example as a slash command; nothing was queued.",
                ),
              );
            if (disposition === "started") restartTurn();
            return Effect.void;
          }),
        ),
      ),
    interrupt: withTurnControl(
      Effect.gen(function* () {
        yield* ipcAck(
          "turn-input-barrier",
          (requestId) => ({
            channel: "pi-subagents",
            type: "turn_input_barrier",
            requestId,
          }),
          () =>
            new SubagentProcessError({
              operation: "await turn-input barrier acknowledgment from",
              code: "turn_input_barrier_unconfirmed",
              message:
                "Subagent did not acknowledge the turn-input barrier; queue clearing and abort were not sent.",
            }),
        );
        yield* rpc({ type: "clear_queue" });
        yield* rpc({ type: "abort" });
      }),
    ),
    reply: (requestId: string, message: string) =>
      withTurnControl(
        ipcAck(
          "parent-reply",
          (ackId) => ({
            channel: "pi-subagents",
            type: "parent_reply",
            requestId,
            ackId,
            message,
          }),
          () =>
            new SubagentProcessError({
              operation: "await parent reply acknowledgment from",
              code: "reply_outcome_uncertain",
              message:
                "Subagent did not acknowledge the parent reply; it may already have applied.",
            }),
        ),
      ),
    notifyPeers: (message: string) =>
      child.sendContactControl({ channel: "pi-subagents", type: "peer_notice", message }),
    isSettlementCurrent: (event: BackendEvent) => event === offeredSettlement?.deref(),
    deliverNotification: (message: string, key: string) =>
      withTurnControl(
        ipcAck(
          "notification",
          (requestId) => ({
            channel: "pi-subagents",
            type: "proxy_notification",
            requestId,
            key,
            message,
          }),
          () =>
            new SubagentProcessError({
              operation: "await descendant notification acknowledgment from",
              code: "transport_outcome_uncertain",
              message:
                "Subagent did not acknowledge the descendant notification; it may already be queued.",
            }),
        ),
      ),
  };

  return {
    pid: child.pid,
    events,
    awaitExit,
    controls,
    acknowledge,
    terminate: child.terminate,
    cleanupVerifier: child.cleanupVerifier,
    cancelPending,
  };
});

export const localPiBackendDriver = (
  childProcesses: ChildProcessContract,
  // Children run on Pi's Node binary; a fake child boundary that never starts Node replaces the check.
  nodeExecutableCheck: Effect.Effect<void, InvalidSubagentRequestError> = requireNodeExecutable(),
): BackendDriver => ({
  runtime: "pi",
  capabilities: PI_SUBAGENT_CAPABILITIES,
  supportsContext: (context) => context === "fresh" || context === "fork",
  preflight: (request) =>
    isSafeNativeModelSelector(request.model)
      ? nodeExecutableCheck
      : Effect.fail(
          new InvalidSubagentRequestError({
            code: "pi_model_unsupported",
            message: "Pi model selector is empty, excessive, or unsafe.",
          }),
        ),
  spawn: Effect.fn("LocalPiBackend.spawn")(function* (request: BackendLaunchRequest) {
    const { resumeToken, ...launch } = request;
    const resumeSessionFile = resumeToken
      ? (yield* decodeLocalPiResumeToken(resumeToken)).sessionFile
      : undefined;
    const child = yield* childProcesses.spawn({
      ...launch,
      ...(resumeSessionFile && { resumeSessionFile }),
    });
    return yield* makeLocalPiHandle(child);
  }),
  reclaimRunState: (request) => childProcesses.reclaimRunState(request),
});
