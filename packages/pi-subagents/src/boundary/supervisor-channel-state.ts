import type { TokenVerifier } from "pi-cosmic-core";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Queue from "effect/Queue";
import type { BackendReport } from "../backend/model.ts";
import type {
  SupervisorChannelId,
  SupervisorDeliveryId,
  SupervisorEvent,
  SupervisorProgressRpc,
  SupervisorRpcFailure,
  SupervisorRunId,
} from "../supervisor/protocol.ts";
import {
  channelError,
  epochError,
  rpcFailure,
  type SupervisorChannelError,
} from "./supervisor-channel-errors.ts";
import {
  SupervisorRpcConnection,
  type SupervisorRpcConnectionContract,
} from "./supervisor-rpc-protocol.ts";

export interface AssignmentUpdate {
  readonly kind: "assignment";
  readonly updateId: SupervisorChannelId;
  readonly assignmentEpoch: number;
}

interface RpcPeer {
  readonly clientId: number;
  readonly guard: SupervisorRpcConnectionContract;
  readonly assignments: Queue.Queue<AssignmentUpdate, Cause.Done>;
  watching: boolean;
}

export interface PendingQuestion {
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

interface AuthenticatedRequest {
  readonly runId: string;
  readonly token: string;
}

interface PendingEpochAcknowledgement {
  readonly epoch: number;
  readonly peerId: number;
  readonly firstAcknowledgement: Deferred.Deferred<void, SupervisorChannelError>;
}

export type SupervisorContactPayload = typeof SupervisorProgressRpc.payloadSchema.Type;

export interface SupervisorChannelState {
  readonly runId: SupervisorRunId;
  readonly verifyToken: TokenVerifier;
  readonly events: Queue.Queue<SupervisorEvent, Cause.Done>;
  readonly peers: Map<number, RpcPeer>;
  readonly assignmentEpochs: Set<number>;
  readonly questionEpochs: Set<number>;
  readonly reports: Map<SupervisorDeliveryId, BackendReport>;
  readonly epochAcknowledgements: Map<SupervisorChannelId, PendingEpochAcknowledgement>;
  readonly readiness: Latch.Latch;
  pendingAssignmentEpoch: number | undefined;
  currentAssignmentEpoch: number;
  nextReportSequence: number;
  pendingQuestion: PendingQuestion | undefined;
  closed: boolean;
}

export const supervisorChannelState = (
  runId: SupervisorRunId,
  verifyToken: TokenVerifier,
  events: Queue.Queue<SupervisorEvent, Cause.Done>,
): Effect.Effect<SupervisorChannelState> =>
  Effect.map(Latch.make(), (readiness) => ({
    runId,
    verifyToken,
    events,
    peers: new Map(),
    assignmentEpochs: new Set(),
    questionEpochs: new Set(),
    reports: new Map(),
    epochAcknowledgements: new Map(),
    readiness,
    pendingAssignmentEpoch: undefined,
    currentAssignmentEpoch: 0,
    nextReportSequence: 1,
    pendingQuestion: undefined,
    closed: false,
  }));

export const hasReadyPeer = (state: SupervisorChannelState): boolean =>
  [...state.peers.values()].some((peer) => peer.watching);

export const synchronizeReadiness = (state: SupervisorChannelState): void => {
  if (hasReadyPeer(state)) Latch.openUnsafe(state.readiness);
  else Latch.closeUnsafe(state.readiness);
};

export const hasEventCapacity = (state: SupervisorChannelState, reserved: number): boolean =>
  Queue.sizeUnsafe(state.events) <= state.events.capacity - reserved;

export const offerContact = (
  state: SupervisorChannelState,
  kind: "progress" | "warning" | "question",
  payload: SupervisorContactPayload,
): boolean =>
  hasEventCapacity(state, 2) &&
  Queue.offerUnsafe(state.events, {
    type: "supervisor_contact",
    assignmentEpoch: payload.assignmentEpoch,
    requestId: payload.requestId,
    kind,
    message: payload.message,
  });

export const failPendingQuestion = (
  state: SupervisorChannelState,
  code: string,
  message: string,
  publishCancellation = true,
): void => {
  const pending = state.pendingQuestion;
  if (!pending) return;
  if (
    publishCancellation &&
    !Queue.offerUnsafe(state.events, {
      type: "supervisor_question_cancelled",
      assignmentEpoch: pending.epoch,
      requestId: pending.requestId,
    })
  )
    return;
  state.pendingQuestion = undefined;
  Deferred.doneUnsafe(pending.response, Effect.fail(rpcFailure(code, message)));
  Deferred.doneUnsafe(pending.acknowledgement, Effect.fail(channelError("reply", code, message)));
};

export const removePeer = (state: SupervisorChannelState, clientId: number): void => {
  const { peers, epochAcknowledgements } = state;
  const peer = peers.get(clientId);
  if (!peer) return;
  peers.delete(clientId);
  synchronizeReadiness(state);
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
          epochError(
            "assignment_epoch_outcome_uncertain",
            "Every assignment epoch acknowledgement transport closed.",
          ),
        ),
      );
  }
  if (state.pendingQuestion?.peerId === clientId)
    failPendingQuestion(
      state,
      "question_transport_closed",
      "The supervisor question transport closed before settlement was confirmed.",
    );
};

export const authorize = (
  state: SupervisorChannelState,
  clientId: number,
  payload: AuthenticatedRequest,
): Effect.Effect<SupervisorRpcConnectionContract, SupervisorRpcFailure> =>
  Effect.gen(function* () {
    const guard = yield* Effect.serviceOption(SupervisorRpcConnection).pipe(
      Effect.flatMap(
        Effect.fromOption(() =>
          rpcFailure("connection_context_missing", "Supervisor connection context is missing."),
        ),
      ),
    );
    const refuse = () => {
      guard.close();
      return rpcFailure("authentication_failed", "Supervisor authentication failed.");
    };
    if (
      state.closed ||
      guard.closed ||
      payload.runId !== state.runId ||
      guard.clientId !== clientId
    )
      return yield* refuse();
    const { verifyToken } = state;
    const authenticated = yield* verifyToken(payload.token).pipe(Effect.orElseSucceed(() => false));
    if (!authenticated || state.closed || guard.closed) return yield* refuse();
    if (!guard.accepted) {
      guard.accepted = true;
      Deferred.doneUnsafe(guard.authenticated, Effect.void);
    }
    return guard;
  });

export const authorizePeer = (
  state: SupervisorChannelState,
  clientId: number,
  payload: AuthenticatedRequest,
): Effect.Effect<RpcPeer, SupervisorRpcFailure> =>
  Effect.flatMap(authorize(state, clientId, payload), () => {
    const peer = state.peers.get(clientId);
    return peer
      ? Effect.succeed(peer)
      : Effect.fail(rpcFailure("session_not_open", "The supervisor RPC session is not open."));
  });

export const authorizeAssignment = (
  state: SupervisorChannelState,
  clientId: number,
  payload: AuthenticatedRequest & { readonly assignmentEpoch: number },
): Effect.Effect<RpcPeer, SupervisorRpcFailure> =>
  Effect.tap(authorizePeer(state, clientId, payload), () =>
    state.assignmentEpochs.has(payload.assignmentEpoch)
      ? Effect.void
      : Effect.fail(
          rpcFailure(
            "unknown_assignment_epoch",
            "Supervisor event did not name an assignment epoch issued by this channel.",
          ),
        ),
  );
