import { synchronousRandomHex, type TokenVerifier } from "pi-cosmic-core";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type { BackendAgentMessaging, BackendReport } from "../backend/model.ts";
import {
  SupervisorChannelIdSchema,
  type SupervisorEvent,
  type SupervisorRunId,
  validSupervisorReply,
} from "../supervisor/protocol.ts";
import {
  channelError,
  epochError,
  type SupervisorChannelError,
} from "./supervisor-channel-errors.ts";
import { supervisorChannelHandlers } from "./supervisor-channel-handlers.ts";
import {
  failPendingQuestion,
  hasReadyPeer,
  supervisorChannelState,
  removePeer,
} from "./supervisor-channel-state.ts";

const MAX_TRACKED_ASSIGNMENTS = 256;
const REPLY_TIMEOUT = "10 seconds";

export interface SupervisorChannelControls {
  readonly awaitReady: Effect.Effect<void, SupervisorChannelError>;
  readonly setAssignmentEpoch: (epoch: number) => Effect.Effect<void, SupervisorChannelError>;
  readonly hasAcceptedReport: (epoch: number) => Effect.Effect<boolean, SupervisorChannelError>;
  readonly acceptedReportForEpoch: (
    epoch: number,
  ) => Effect.Effect<BackendReport | undefined, SupervisorChannelError>;
  readonly reply: (
    requestId: string,
    message: string,
  ) => Effect.Effect<void, SupervisorChannelError>;
  readonly cancelPending: (reason?: string) => void;
  /** Admits main-agent-only calls only from this native thread when the caller names its thread. */
  readonly setMainAgentThread: (threadId: string) => void;
}

export const supervisorChannelSession = ({
  runId,
  verifyToken,
  events,
  agents,
}: {
  readonly runId: SupervisorRunId;
  readonly verifyToken: TokenVerifier;
  readonly events: Queue.Queue<SupervisorEvent, Cause.Done>;
  readonly agents?: BackendAgentMessaging | undefined;
}) =>
  Effect.gen(function* () {
    const state = yield* supervisorChannelState(runId, verifyToken, events, agents);
    const { peers, assignmentEpochs, reports, epochAcknowledgements, readiness } = state;
    const handlers = supervisorChannelHandlers(state);

    const shutdown = Effect.gen(function* () {
      state.closed = true;
      Latch.openUnsafe(readiness);
      failPendingQuestion(
        state,
        "channel_closed",
        "Supervisor channel closed before the pending question settled.",
        false,
      );
      for (const acknowledgement of epochAcknowledgements.values())
        Deferred.doneUnsafe(
          acknowledgement.firstAcknowledgement,
          Effect.fail(
            epochError("channel_closed", "Supervisor channel closed before epoch acknowledgement."),
          ),
        );
      epochAcknowledgements.clear();
      for (const peer of peers.values()) Queue.endUnsafe(peer.assignments);
      peers.clear();
      yield* Queue.shutdown(events);
    });

    const waitUntilReady = (): Effect.Effect<void, SupervisorChannelError> =>
      Effect.suspend(() => {
        if (state.closed)
          return Effect.fail(
            channelError("await ready", "channel_closed", "Supervisor channel is closed."),
          );
        if (hasReadyPeer(state)) return Effect.void;
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

    const setAssignmentEpoch = Effect.fn("SupervisorChannel.setAssignmentEpoch")(function* (
      epoch: number,
    ) {
      if (
        state.closed ||
        !Number.isSafeInteger(epoch) ||
        epoch <= state.currentAssignmentEpoch ||
        assignmentEpochs.size >= MAX_TRACKED_ASSIGNMENTS ||
        state.pendingAssignmentEpoch !== undefined
      )
        return yield* epochError(
          "invalid_assignment_epoch",
          "Assignment epoch cannot advance in the current channel state.",
        );
      const watchingPeers = [...peers.values()].filter((peer) => peer.watching);
      if (watchingPeers.length === 0)
        return yield* epochError(
          "supervisor_helper_unavailable",
          "Assignment epoch cannot advance without an authenticated helper.",
        );
      const firstAcknowledgement = Deferred.makeUnsafe<void, SupervisorChannelError>();
      state.pendingAssignmentEpoch = epoch;
      return yield* Effect.gen(function* () {
        let delivered = 0;
        for (const peer of watchingPeers) {
          const updateId = SupervisorChannelIdSchema.make(`epoch-${synchronousRandomHex(16)}`);
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
          return yield* epochError(
            "supervisor_helper_unavailable",
            "No authenticated helper accepted the assignment update.",
          );
        yield* Deferred.await(firstAcknowledgement).pipe(
          Effect.timeoutOrElse({
            duration: REPLY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                epochError(
                  "assignment_epoch_outcome_uncertain",
                  "Assignment epoch acknowledgement timed out.",
                ),
              ),
          }),
        );
        return undefined;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            state.pendingAssignmentEpoch = undefined;
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
        if (
          state.closed ||
          !Number.isSafeInteger(epoch) ||
          epoch < 1 ||
          !assignmentEpochs.has(epoch)
        )
          return Effect.fail(
            channelError(
              "read report evidence",
              "invalid_assignment_epoch",
              "Report evidence epoch is invalid.",
            ),
          );
        const accepted = [...reports.values()].find((entry) => entry.assignmentEpoch === epoch);
        return Effect.succeed(accepted);
      });

    const reply = Effect.fn("SupervisorChannel.reply")(function* (
      requestId: string,
      message: string,
    ) {
      const pending = state.pendingQuestion;
      if (
        state.closed ||
        !pending ||
        pending.requestId !== requestId ||
        pending.epoch !== state.currentAssignmentEpoch ||
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
        if (state.pendingQuestion === pending)
          failPendingQuestion(
            state,
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
      return undefined;
    });

    const cancelPending = (reason?: string): void => {
      const trimmed = reason?.trim();
      failPendingQuestion(
        state,
        "question_cancelled",
        trimmed ? trimmed.slice(0, 512) : "The pending supervisor question was cancelled.",
      );
    };

    return {
      handlers,
      disconnect: (clientId: number) => removePeer(state, clientId),
      shutdown,
      controls: {
        awaitReady,
        setAssignmentEpoch,
        acceptedReportForEpoch,
        hasAcceptedReport: (epoch) =>
          acceptedReportForEpoch(epoch).pipe(Effect.map((report) => report !== undefined)),
        reply,
        cancelPending,
        setMainAgentThread: (threadId) => {
          state.mainAgentThreadId = threadId;
        },
      } satisfies SupervisorChannelControls,
    };
  });
