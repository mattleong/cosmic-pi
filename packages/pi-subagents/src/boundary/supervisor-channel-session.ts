// Private authenticated session state for the loopback supervisor channel.
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { MAX_BACKEND_REPORT_EVIDENCE_CHARS, type BackendReport } from "../backend/model.ts";
import {
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorChannelIdSchema,
  type SupervisorAuthToken,
  type SupervisorChannelId,
  type SupervisorDeliveryId,
  type SupervisorEvent,
  type SupervisorRunId,
  type SupervisorProgressRpc,
  SupervisorRpcFailure,
  SupervisorRpcGroup,
  validSupervisorReply,
} from "../supervisor/protocol.ts";
import { isSupervisorMcpMessage, isSupervisorMcpReport } from "../supervisor/mcp-contract.ts";
import {
  SupervisorRpcConnection,
  type SupervisorRpcConnectionContract,
} from "./supervisor-rpc-protocol.ts";

const MAX_TRACKED_ASSIGNMENTS = 256;
const MAX_REPORT_DELIVERIES = 128;
const REPLY_TIMEOUT = "10 seconds";

export class SupervisorChannelError extends Schema.TaggedError<SupervisorChannelError>()(
  "SupervisorChannelError",
  {
    operation: Schema.String,
    code: Schema.String,
    message: Schema.String,
  },
) {}

export interface SupervisorChannelControls {
  readonly awaitReady: Effect.Effect<void, SupervisorChannelError>;
  readonly setAssignmentEpoch: (epoch: number) => Effect.Effect<void, SupervisorChannelError>;
  readonly hasAcceptedReport: (epoch: number) => Effect.Effect<boolean, SupervisorChannelError>;
  readonly acceptedReportForEpoch: (
    epoch: number,
  ) => Effect.Effect<BackendReport | undefined, SupervisorChannelError>;
  readonly deliverNotification: (message: string) => Effect.Effect<void, SupervisorChannelError>;
  readonly reply: (
    requestId: string,
    message: string,
  ) => Effect.Effect<void, SupervisorChannelError>;
  readonly cancelPending: (reason?: string) => void;
}

type AssignmentUpdate =
  | {
      readonly kind: "assignment";
      readonly updateId: SupervisorChannelId;
      readonly assignmentEpoch: number;
    }
  | {
      readonly kind: "notification";
      readonly updateId: SupervisorChannelId;
      readonly message: string;
    };

interface RpcPeer {
  readonly clientId: number;
  readonly guard: SupervisorRpcConnectionContract;
  readonly assignments: Queue.Queue<AssignmentUpdate, Cause.Done>;
  watching: boolean;
}

interface PendingQuestion {
  readonly requestId: SupervisorChannelId;
  readonly epoch: number;
  readonly peerId: number;
  readonly response: Deferred.Deferred<
    { readonly questionId: SupervisorChannelId; readonly message: string },
    SupervisorRpcFailure
  >;
  readonly acknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
  replyStarted: boolean;
}

interface AcceptedReport {
  readonly epoch: number;
  readonly sequence: number;
  readonly text: string;
  readonly report: BackendReport;
}

interface PendingEpochAcknowledgement {
  readonly epoch: number;
  readonly peerId: number;
  readonly firstAcknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
}

interface PendingNotificationAcknowledgement {
  readonly peerId: number;
  readonly acknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
}

const channelError = (operation: string, code: string, message: string) =>
  new SupervisorChannelError({ operation, code, message });
const rpcFailure = (code: string, message: string) => new SupervisorRpcFailure({ code, message });

const authenticatedToken = <ValueInput>(
  expected: Redacted.Redacted<SupervisorAuthToken>,
  value: ValueInput,
): boolean => {
  const expectedBytes = Buffer.from(Redacted.value(expected), "utf8");
  const supplied = Predicate.isString(value) ? Buffer.from(value, "utf8") : Buffer.alloc(0);
  if (supplied.length !== expectedBytes.length) {
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }
  return timingSafeEqual(expectedBytes, supplied);
};

export const makeSupervisorChannelSession = ({
  runId,
  token,
  events,
  allowPiProxy,
}: {
  readonly runId: SupervisorRunId;
  readonly token: Redacted.Redacted<SupervisorAuthToken>;
  readonly events: Queue.Queue<SupervisorEvent, Cause.Done>;
  readonly allowPiProxy: boolean;
}) =>
  Effect.gen(function* () {
    const peers = new Map<number, RpcPeer>();
    const assignmentEpochs = new Set<number>();
    const questionEpochs = new Set<number>();
    const reports = new Map<SupervisorDeliveryId, AcceptedReport>();
    const epochAcknowledgements = new Map<SupervisorChannelId, PendingEpochAcknowledgement>();
    const notificationAcknowledgements = new Map<
      SupervisorChannelId,
      PendingNotificationAcknowledgement
    >();
    const readiness = yield* Latch.make();
    const contactEventCapacity = events.capacity - 1;
    let pendingAssignmentEpoch: number | undefined;
    let currentAssignmentEpoch = 0;
    let nextReportSequence = 1;
    let pendingQuestion: PendingQuestion | undefined;
    // Each admitted proxy owns a cancellation slot until its RPC wait releases.
    let pendingProxyCalls = 0;
    let closed = false;

    const hasReadyPeer = (): boolean => [...peers.values()].some((peer) => peer.watching);

    const synchronizeReadiness = (): void => {
      if (hasReadyPeer()) Latch.openUnsafe(readiness);
      else Latch.closeUnsafe(readiness);
    };

    const failPendingQuestion = (
      code: string,
      message: string,
      publishCancellation: boolean,
    ): void => {
      const pending = pendingQuestion;
      if (!pending) return;
      if (
        publishCancellation &&
        !Queue.offerUnsafe(events, {
          type: "supervisor_question_cancelled",
          assignmentEpoch: pending.epoch,
          requestId: pending.requestId,
        })
      )
        return;
      pendingQuestion = undefined;
      Deferred.doneUnsafe(pending.response, Effect.fail(rpcFailure(code, message)));
      Deferred.doneUnsafe(
        pending.acknowledgement,
        Effect.fail(channelError("reply", code, message)),
      );
    };

    const cancelPendingQuestion = (code: string, message: string): boolean => {
      if (!pendingQuestion) return false;
      failPendingQuestion(code, message, true);
      return pendingQuestion === undefined;
    };

    const removePeer = (clientId: number): void => {
      const peer = peers.get(clientId);
      if (!peer) return;
      peers.delete(clientId);
      synchronizeReadiness();
      Queue.endUnsafe(peer.assignments);
      const affected = new Set<Deferred.Deferred<void, SupervisorChannelError>>();
      for (const [id, acknowledgement] of epochAcknowledgements) {
        if (acknowledgement.peerId !== clientId) continue;
        epochAcknowledgements.delete(id);
        affected.add(acknowledgement.firstAcknowledgement);
      }
      for (const firstAcknowledgement of affected) {
        const hasLive = [...epochAcknowledgements.values()].some(
          (entry) => entry.firstAcknowledgement === firstAcknowledgement,
        );
        if (!hasLive)
          Deferred.doneUnsafe(
            firstAcknowledgement,
            Effect.fail(
              channelError(
                "set assignment epoch",
                "assignment_epoch_outcome_uncertain",
                "Every assignment epoch acknowledgement transport closed.",
              ),
            ),
          );
      }
      for (const [id, pending] of notificationAcknowledgements) {
        if (pending.peerId !== clientId) continue;
        notificationAcknowledgements.delete(id);
        Deferred.doneUnsafe(
          pending.acknowledgement,
          Effect.fail(
            channelError(
              "deliver notification",
              "notification_transport_closed",
              "The delegated Pi notification transport closed before acknowledgement.",
            ),
          ),
        );
      }
      if (pendingQuestion?.peerId === clientId)
        cancelPendingQuestion(
          "question_transport_closed",
          "The supervisor question transport closed before settlement was confirmed.",
        );
    };

    const authorize = (
      guard: SupervisorRpcConnectionContract,
      clientId: number,
      payload: { readonly version: number; readonly runId: string; readonly token: string },
    ): Effect.Effect<void, SupervisorRpcFailure> =>
      Effect.suspend(() => {
        if (
          closed ||
          payload.version !== SUPERVISOR_CHANNEL_VERSION ||
          payload.runId !== runId ||
          !authenticatedToken(token, payload.token) ||
          guard.clientId !== clientId
        ) {
          guard.close();
          return Effect.fail(
            rpcFailure("authentication_failed", "Supervisor authentication failed."),
          );
        }
        if (!guard.accepted) {
          guard.accepted = true;
          Deferred.doneUnsafe(guard.authenticated, Effect.void);
        }
        return Effect.void;
      });

    const currentConnectionGuard = Effect.serviceOption(SupervisorRpcConnection).pipe(
      Effect.flatMap((guard) =>
        Option.isSome(guard)
          ? Effect.succeed(guard.value)
          : Effect.fail(
              rpcFailure("connection_context_missing", "Supervisor connection context is missing."),
            ),
      ),
    );

    const requirePeer = (clientId: number): Effect.Effect<RpcPeer, SupervisorRpcFailure> => {
      const peer = peers.get(clientId);
      return peer
        ? Effect.succeed(peer)
        : Effect.fail(rpcFailure("session_not_open", "The supervisor RPC session is not open."));
    };

    const requireAssignedEpoch = (epoch: number): Effect.Effect<void, SupervisorRpcFailure> =>
      assignmentEpochs.has(epoch)
        ? Effect.void
        : Effect.fail(
            rpcFailure(
              "unknown_assignment_epoch",
              "Supervisor event did not name an assignment epoch issued by this channel.",
            ),
          );

    const offerContact = (
      requestId: SupervisorChannelId,
      epoch: number,
      kind: "progress" | "warning",
      message: string,
    ): Effect.Effect<string, SupervisorRpcFailure> =>
      Effect.suspend(() => {
        if (!isSupervisorMcpMessage(message))
          return Effect.fail(rpcFailure("invalid_message", "Supervisor message is invalid."));
        const offered =
          Queue.sizeUnsafe(events) < contactEventCapacity - pendingProxyCalls &&
          Queue.offerUnsafe(events, {
            type: "supervisor_contact",
            assignmentEpoch: epoch,
            requestId,
            kind,
            message,
          });
        return offered
          ? Effect.succeed(
              kind === "progress"
                ? "Progress delivered to the parent projection."
                : "Warning recorded in parent-visible run status.",
            )
          : Effect.fail(rpcFailure("event_queue_full", "Supervisor event queue is full."));
      });

    const dispatchContact = (
      kind: "progress" | "warning",
      payload: typeof SupervisorProgressRpc.payloadSchema.Type,
      clientId: number,
    ) =>
      Effect.gen(function* () {
        const guard = yield* currentConnectionGuard;
        yield* authorize(guard, clientId, payload);
        yield* requirePeer(clientId);
        yield* requireAssignedEpoch(payload.assignmentEpoch);
        return yield* offerContact(
          payload.requestId,
          payload.assignmentEpoch,
          kind,
          payload.message,
        );
      });

    const handlers = SupervisorRpcGroup.toHandlers(
      SupervisorRpcGroup.of({
        SupervisorOpenSession: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            if (!peers.has(options.client.id)) {
              const assignments = yield* Queue.bounded<AssignmentUpdate, Cause.Done>(4);
              peers.set(options.client.id, {
                clientId: options.client.id,
                guard,
                assignments,
                watching: false,
              });
            }
            return { assignmentEpoch: currentAssignmentEpoch };
          }),

        SupervisorWatchAssignments: (payload, options) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const guard = yield* currentConnectionGuard;
              yield* authorize(guard, options.client.id, payload);
              const peer = yield* requirePeer(options.client.id);
              if (peer.watching)
                return yield* rpcFailure(
                  "assignment_watch_active",
                  "This supervisor session already has an assignment stream.",
                );
              peer.watching = true;
              synchronizeReadiness();
              return Stream.fromQueue(peer.assignments).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    peer.watching = false;
                    synchronizeReadiness();
                  }),
                ),
              );
            }),
          ),

        SupervisorAcknowledgeAssignment: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            yield* requirePeer(options.client.id);
            const acknowledgement = epochAcknowledgements.get(payload.updateId);
            if (
              !acknowledgement ||
              acknowledgement.peerId !== options.client.id ||
              acknowledgement.epoch !== payload.assignmentEpoch
            )
              return yield* rpcFailure(
                "assignment_epoch_ack_mismatch",
                "Assignment epoch acknowledgement did not match an issued update.",
              );
            epochAcknowledgements.delete(payload.updateId);
            if (pendingAssignmentEpoch === acknowledgement.epoch) {
              if (pendingQuestion && pendingQuestion.epoch < acknowledgement.epoch)
                cancelPendingQuestion(
                  "question_assignment_advanced",
                  "The pending supervisor question belonged to a prior assignment.",
                );
              currentAssignmentEpoch = acknowledgement.epoch;
              assignmentEpochs.add(acknowledgement.epoch);
            }
            Deferred.doneUnsafe(acknowledgement.firstAcknowledgement, Effect.void);
          }),

        SupervisorAcknowledgeNotification: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            yield* requirePeer(options.client.id);
            const pending = notificationAcknowledgements.get(payload.updateId);
            if (!pending || pending.peerId !== options.client.id)
              return yield* rpcFailure(
                "notification_ack_mismatch",
                "Notification acknowledgement did not match an issued update.",
              );
            notificationAcknowledgements.delete(payload.updateId);
            Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
          }),

        SupervisorProgress: (payload, options) =>
          dispatchContact("progress", payload, options.client.id),
        SupervisorWarning: (payload, options) =>
          dispatchContact("warning", payload, options.client.id),

        SupervisorQuestion: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            yield* requirePeer(options.client.id);
            yield* requireAssignedEpoch(payload.assignmentEpoch);
            if (!isSupervisorMcpMessage(payload.message))
              return yield* rpcFailure("invalid_question", "Supervisor question is invalid.");
            if (pendingQuestion)
              return yield* rpcFailure(
                "question_pending",
                "A blocking supervisor question is already pending.",
              );
            if (questionEpochs.has(payload.assignmentEpoch))
              return yield* rpcFailure(
                "question_already_used",
                "This assignment already used its blocking supervisor question.",
              );
            const response = Deferred.makeUnsafe<
              { readonly questionId: SupervisorChannelId; readonly message: string },
              SupervisorRpcFailure
            >();
            const acknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
            const pending: PendingQuestion = {
              requestId: payload.requestId,
              epoch: payload.assignmentEpoch,
              peerId: options.client.id,
              response,
              acknowledgement,
              replyStarted: false,
            };
            pendingQuestion = pending;
            const offered =
              Queue.sizeUnsafe(events) < contactEventCapacity - pendingProxyCalls &&
              Queue.offerUnsafe(events, {
                type: "supervisor_contact",
                assignmentEpoch: payload.assignmentEpoch,
                requestId: payload.requestId,
                kind: "question",
                message: payload.message,
              });
            if (!offered) {
              pendingQuestion = undefined;
              return yield* rpcFailure("event_queue_full", "Supervisor event queue is full.");
            }
            questionEpochs.add(payload.assignmentEpoch);
            return yield* Deferred.await(response).pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit) && pendingQuestion === pending && !pending.replyStarted)
                    cancelPendingQuestion(
                      "question_cancelled",
                      "The supervisor question call was cancelled.",
                    );
                }),
              ),
            );
          }),

        SupervisorAcknowledgeQuestionReply: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            const pending = pendingQuestion;
            if (
              !pending ||
              pending.peerId !== options.client.id ||
              pending.requestId !== payload.questionId ||
              pending.epoch !== payload.assignmentEpoch ||
              !pending.replyStarted
            )
              return yield* rpcFailure(
                "reply_ack_mismatch",
                "Question reply acknowledgement did not match the pending reply.",
              );
            pendingQuestion = undefined;
            Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
          }),

        SupervisorProxy: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            yield* requirePeer(options.client.id);
            if (!allowPiProxy)
              return yield* rpcFailure(
                "pi_proxy_forbidden",
                "This authenticated supervisor channel does not belong to a Pi run.",
              );
            return yield* Effect.acquireUseRelease(
              Effect.suspend(() => {
                const requiredSlots = pendingProxyCalls + (pendingQuestion === undefined ? 2 : 3);
                if (Queue.sizeUnsafe(events) > events.capacity - requiredSlots)
                  return Effect.fail(
                    rpcFailure("event_queue_full", "Supervisor event queue is full."),
                  );
                const response = Deferred.makeUnsafe<{
                  readonly ok: boolean;
                  readonly payloadJson: string;
                }>();
                const offered = Queue.offerUnsafe(events, {
                  type: "proxy_request",
                  requestId: payload.requestId,
                  tool: payload.tool,
                  argumentsJson: payload.argumentsJson,
                  respond: (ok, payloadJson) =>
                    Effect.sync(() => {
                      Deferred.doneUnsafe(response, Effect.succeed({ ok, payloadJson }));
                    }),
                });
                if (!offered)
                  return Effect.fail(
                    rpcFailure("event_queue_full", "Supervisor event queue is full."),
                  );
                pendingProxyCalls += 1;
                return Effect.succeed(response);
              }),
              (response) => Deferred.await(response),
              (_, exit) =>
                Effect.sync(() => {
                  pendingProxyCalls -= 1;
                  if (Exit.hasInterrupts(exit))
                    Queue.offerUnsafe(events, {
                      type: "proxy_cancel",
                      requestId: payload.requestId,
                    });
                }),
            );
          }),

        SupervisorReport: (payload, options) =>
          Effect.gen(function* () {
            const guard = yield* currentConnectionGuard;
            yield* authorize(guard, options.client.id, payload);
            yield* requirePeer(options.client.id);
            yield* requireAssignedEpoch(payload.assignmentEpoch);
            if (!isSupervisorMcpReport(payload.text))
              return yield* rpcFailure("invalid_report", "Supervisor report is invalid.");
            const previous = reports.get(payload.deliveryId);
            if (previous) {
              if (previous.epoch !== payload.assignmentEpoch || previous.text !== payload.text)
                return yield* rpcFailure(
                  "delivery_identity_conflict",
                  "The report delivery identity was already used for different evidence.",
                );
              return {
                duplicate: true,
                sequence: previous.sequence,
                assignmentEpoch: previous.epoch,
              };
            }
            if (reports.size >= MAX_REPORT_DELIVERIES)
              return yield* rpcFailure(
                "report_identity_capacity",
                "The report delivery identity map is full.",
              );
            const sequence = nextReportSequence;
            const report: BackendReport & { readonly type: "report" } = {
              type: "report",
              runId,
              assignmentEpoch: payload.assignmentEpoch,
              sequence,
              deliveryId: payload.deliveryId,
              text: payload.text,
              evidence: `supervisor-effect-rpc-v${SUPERVISOR_CHANNEL_VERSION}`.slice(
                0,
                MAX_BACKEND_REPORT_EVIDENCE_CHARS,
              ),
            };
            const cancelsQuestion =
              pendingQuestion !== undefined && pendingQuestion.epoch <= payload.assignmentEpoch;
            const requiredSlots = pendingProxyCalls + (pendingQuestion === undefined ? 1 : 2);
            if (
              Queue.sizeUnsafe(events) > events.capacity - requiredSlots ||
              !Queue.offerUnsafe(events, report)
            )
              return yield* rpcFailure("event_queue_full", "Supervisor event queue is full.");
            if (cancelsQuestion)
              cancelPendingQuestion(
                "question_cancelled_by_report",
                "The pending question was cancelled because its assignment report was accepted.",
              );
            reports.set(payload.deliveryId, {
              epoch: payload.assignmentEpoch,
              sequence,
              text: payload.text,
              report,
            });
            nextReportSequence += 1;
            return { duplicate: false, sequence, assignmentEpoch: payload.assignmentEpoch };
          }),
      }),
    );

    const shutdown = Effect.gen(function* () {
      closed = true;
      Latch.openUnsafe(readiness);
      failPendingQuestion(
        "channel_closed",
        "Supervisor channel closed before the pending question settled.",
        false,
      );
      for (const acknowledgement of epochAcknowledgements.values())
        Deferred.doneUnsafe(
          acknowledgement.firstAcknowledgement,
          Effect.fail(
            channelError(
              "set assignment epoch",
              "channel_closed",
              "Supervisor channel closed before epoch acknowledgement.",
            ),
          ),
        );
      epochAcknowledgements.clear();
      for (const pending of notificationAcknowledgements.values())
        Deferred.doneUnsafe(
          pending.acknowledgement,
          Effect.fail(
            channelError(
              "deliver notification",
              "channel_closed",
              "Supervisor channel closed before notification acknowledgement.",
            ),
          ),
        );
      notificationAcknowledgements.clear();
      for (const peer of peers.values()) Queue.endUnsafe(peer.assignments);
      peers.clear();
      yield* Queue.shutdown(events);
    });

    const waitUntilReady = (): Effect.Effect<void, SupervisorChannelError> =>
      Effect.suspend(() => {
        if (closed)
          return Effect.fail(
            channelError("await ready", "channel_closed", "Supervisor channel is closed."),
          );
        if (hasReadyPeer()) return Effect.void;
        return Latch.await(readiness).pipe(Effect.flatMap(() => waitUntilReady()));
      });
    const awaitReady: Effect.Effect<void, SupervisorChannelError> = waitUntilReady().pipe(
      Effect.timeoutOrElse({
        duration: REPLY_TIMEOUT,
        orElse: () =>
          Effect.fail(
            channelError(
              "await ready",
              "supervisor_helper_unavailable",
              "No authenticated supervisor helper became ready.",
            ),
          ),
      }),
    );

    const setAssignmentEpoch: SupervisorChannelControls["setAssignmentEpoch"] = (epoch) =>
      Effect.gen(function* () {
        if (
          closed ||
          !Number.isSafeInteger(epoch) ||
          epoch <= currentAssignmentEpoch ||
          assignmentEpochs.size >= MAX_TRACKED_ASSIGNMENTS ||
          pendingAssignmentEpoch !== undefined
        )
          return yield* channelError(
            "set assignment epoch",
            "invalid_assignment_epoch",
            "Assignment epoch cannot advance in the current channel state.",
          );
        const watchingPeers = [...peers.values()].filter((peer) => peer.watching);
        if (watchingPeers.length === 0)
          return yield* channelError(
            "set assignment epoch",
            "supervisor_helper_unavailable",
            "Assignment epoch cannot advance without an authenticated helper.",
          );
        const firstAcknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
        pendingAssignmentEpoch = epoch;
        return yield* Effect.gen(function* () {
          let delivered = 0;
          for (const peer of watchingPeers) {
            const updateId = SupervisorChannelIdSchema.make(
              `epoch-${randomBytes(16).toString("hex")}`,
            );
            epochAcknowledgements.set(updateId, {
              epoch,
              peerId: peer.clientId,
              firstAcknowledgement,
            });
            if (
              Queue.offerUnsafe(peer.assignments, {
                kind: "assignment",
                updateId,
                assignmentEpoch: epoch,
              })
            ) {
              delivered += 1;
            } else {
              epochAcknowledgements.delete(updateId);
              peer.guard.close();
            }
          }
          if (delivered === 0)
            return yield* channelError(
              "set assignment epoch",
              "supervisor_helper_unavailable",
              "No authenticated helper accepted the assignment update.",
            );
          yield* Deferred.await(firstAcknowledgement).pipe(
            Effect.timeoutOrElse({
              duration: REPLY_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  channelError(
                    "set assignment epoch",
                    "assignment_epoch_outcome_uncertain",
                    "Assignment epoch acknowledgement timed out.",
                  ),
                ),
            }),
          );
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              pendingAssignmentEpoch = undefined;
              if (Exit.isSuccess(exit)) return;
              for (const [id, acknowledgement] of epochAcknowledgements)
                if (acknowledgement.firstAcknowledgement === firstAcknowledgement)
                  epochAcknowledgements.delete(id);
            }),
          ),
        );
      });

    const acceptedReportForEpoch: SupervisorChannelControls["acceptedReportForEpoch"] = (epoch) =>
      Effect.suspend(() => {
        if (closed || !Number.isSafeInteger(epoch) || epoch < 1 || !assignmentEpochs.has(epoch))
          return Effect.fail(
            channelError(
              "read report evidence",
              "invalid_assignment_epoch",
              "Report evidence epoch is invalid.",
            ),
          );
        // Accepted entries are inserted in sequence order and never replaced.
        const accepted = [...reports.values()].find((entry) => entry.epoch === epoch);
        return Effect.succeed(accepted?.report);
      });

    const deliverNotification: SupervisorChannelControls["deliverNotification"] = (message) =>
      Effect.gen(function* () {
        const normalized = message.trim();
        if (!allowPiProxy || !normalized || normalized.length > 32 * 1024)
          return yield* channelError(
            "deliver notification",
            "notification_invalid",
            "Delegated Pi notification is unavailable or invalid.",
          );
        const peer = [...peers.values()].find((candidate) => candidate.watching);
        if (!peer)
          return yield* channelError(
            "deliver notification",
            "supervisor_helper_unavailable",
            "No authenticated delegated Pi helper is connected.",
          );
        const updateId = SupervisorChannelIdSchema.make(
          `notification-${randomBytes(16).toString("hex")}`,
        );
        const acknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
        notificationAcknowledgements.set(updateId, {
          peerId: peer.clientId,
          acknowledgement,
        });
        if (
          !Queue.offerUnsafe(peer.assignments, {
            kind: "notification",
            updateId,
            message: normalized,
          })
        ) {
          notificationAcknowledgements.delete(updateId);
          return yield* channelError(
            "deliver notification",
            "notification_outcome_uncertain",
            "Delegated Pi notification queue is unavailable.",
          );
        }
        const acknowledged = yield* Deferred.await(acknowledgement).pipe(
          Effect.timeoutOption(REPLY_TIMEOUT),
        );
        if (Option.isNone(acknowledged)) {
          notificationAcknowledgements.delete(updateId);
          return yield* channelError(
            "deliver notification",
            "notification_outcome_uncertain",
            "Delegated Pi notification acknowledgement timed out.",
          );
        }
      });

    const reply: SupervisorChannelControls["reply"] = (requestId, message) =>
      Effect.gen(function* () {
        const pending = pendingQuestion;
        if (
          closed ||
          !pending ||
          pending.requestId !== requestId ||
          pending.epoch !== currentAssignmentEpoch ||
          pending.replyStarted
        )
          return yield* channelError(
            "reply",
            "question_ownership_mismatch",
            "No exact pending supervisor question owns this reply.",
          );
        if (!validSupervisorReply(message))
          return yield* channelError(
            "reply",
            "invalid_reply",
            "Supervisor reply must be non-empty and bounded.",
          );
        pending.replyStarted = true;
        Deferred.doneUnsafe(
          pending.response,
          Effect.succeed({ questionId: pending.requestId, message: message.trim() }),
        );
        const acknowledged = yield* Deferred.await(pending.acknowledgement).pipe(
          Effect.timeoutOption(REPLY_TIMEOUT),
        );
        if (Option.isNone(acknowledged)) {
          if (pendingQuestion === pending)
            failPendingQuestion(
              "reply_outcome_uncertain",
              "Parent reply acknowledgement timed out.",
              false,
            );
          return yield* channelError(
            "reply",
            "reply_outcome_uncertain",
            "Parent reply delivery could not be confirmed.",
          );
        }
      });

    const cancelPending = (reason?: string): void => {
      const trimmed = reason?.trim();
      cancelPendingQuestion(
        "question_cancelled",
        trimmed ? trimmed.slice(0, 512) : "The pending supervisor question was cancelled.",
      );
    };

    return {
      handlers,
      disconnect: removePeer,
      shutdown,
      controls: {
        awaitReady,
        setAssignmentEpoch,
        acceptedReportForEpoch,
        hasAcceptedReport: (epoch) =>
          acceptedReportForEpoch(epoch).pipe(Effect.map((report) => report !== undefined)),
        deliverNotification,
        reply,
        cancelPending,
      } satisfies SupervisorChannelControls,
    };
  });
