import * as Effect from "effect/Effect";
import { makeLocalCliEventIngress } from "./local-cli-events.ts";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  type ChildProcessHandle,
  type ChildProcessContract,
  type ChildWireEvent,
} from "../boundary/child-process.ts";
import {
  InvalidSubagentRequestError,
  isOutcomeUncertain,
  SubagentProcessError,
  type SubagentError,
} from "../run/errors.ts";
import { PI_SUBAGENT_CAPABILITIES } from "../run/model.ts";
import { makeLocalPiUsage } from "./local-pi-usage.ts";
import { isSafeNativeModelSelector } from "../profiles/model.ts";
import { decodeRpcEnvelope, decodeRpcStateData, rpcStateModelId } from "./local-pi-protocol.ts";
import {
  normalizeParentContact,
  normalizeRpcEvent,
  parentContactAckOutcome,
} from "./local-pi-events.ts";
import { makeLocalPiRpc } from "./local-pi-rpc.ts";
import { MAX_ERROR_CHARS, sanitizeStreamDiagnostic } from "../run/state.ts";
import { protocolError } from "./driver-shared.ts";
import {
  toBackendExit,
  type BackendAssistantTerminal,
  type BackendDriver,
  type BackendEvent,
  type BackendLaunchRequest,
  type BackendResumeToken,
} from "./model.ts";

const STARTUP_RPC_TIMEOUT = "30 seconds";

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
  const {
    rpc,
    ipcAck,
    resolveIpcAck,
    resolveResponse,
    cancel: cancelPending,
  } = makeLocalPiRpc(child);
  let assignmentEpoch = 0;
  let latestTerminal: BackendAssistantTerminal | undefined;
  let transportFailure: SubagentError | undefined;

  const { events, offer, release, acknowledge } = yield* makeLocalCliEventIngress(
    child.acknowledge,
    "local-Pi",
  );

  const awaitExit = child.awaitExit.pipe(
    Effect.map((exit) => {
      const summary = `Subagent process exited${exit.exitCode === null ? "" : ` with code ${exit.exitCode}`}${exit.signal ? ` (${exit.signal})` : ""}.`;
      const stderr = exit.stderr.trim();
      return {
        ...toBackendExit(exit),
        diagnostic: stderr
          ? `${summary} ${sanitizeStreamDiagnostic(stderr, MAX_ERROR_CHARS - summary.length - 1)}`
          : summary,
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
  const accountUsage = makeLocalPiUsage();
  const usageControl = yield* Semaphore.make(1);
  const withUsageControl = usageControl.withPermits(1);
  let usageDirty = false;
  let usageReady = false;
  let pendingSettlement: Extract<BackendEvent, { type: "run_settled" }> | undefined;
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
        if (settlement.assignmentEpoch === assignmentEpoch) yield* offer(settlement);
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

  const consumeChildEvent = (event: ChildWireEvent): Effect.Effect<void> => {
    if (event.type === "protocol_error")
      return offer({ type: "protocol_error", message: event.message }, event);
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
      Effect.flatMap((envelope) => {
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
        ) {
          latestTerminal = undefined;
          pendingSettlement = undefined;
        }
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
      }),
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
        transportFailure = new SubagentProcessError({ operation: "run", message: exit.diagnostic });
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
              Effect.tapError((error) =>
                Effect.sync(() => {
                  const outcomeUncertain =
                    error._tag === "SubagentProcessError" && isOutcomeUncertain(error);
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
    steer: (message: string) =>
      withTurnControl(rpc({ type: "steer", message }).pipe(Effect.asVoid)),
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
    renameDisplay: (name: string) => rpc({ type: "set_session_name", name }).pipe(Effect.asVoid),
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
    deliverNotification: (message: string) =>
      withTurnControl(
        ipcAck(
          "notification",
          (requestId) => ({
            channel: "pi-subagents",
            type: "proxy_notification",
            requestId,
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
    cancelPending,
  };
});

export const makeLocalPiBackendDriver = (childProcesses: ChildProcessContract): BackendDriver => ({
  host: "local",
  runtime: "pi",
  capabilities: PI_SUBAGENT_CAPABILITIES,
  supportsContext: (context) => context === "fresh" || context === "fork",
  preflight: (request) =>
    isSafeNativeModelSelector(request.model)
      ? Effect.void
      : Effect.fail(
          new InvalidSubagentRequestError({
            code: "pi_model_unsupported",
            message: "Pi model selector is empty, excessive, or unsafe.",
          }),
        ),
  spawn: (request: BackendLaunchRequest) =>
    Effect.gen(function* () {
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
