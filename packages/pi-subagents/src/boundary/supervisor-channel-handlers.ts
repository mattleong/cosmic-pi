import { safeTextPrefix } from "pi-cosmic-core";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  type BackendAgentMessaging,
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
  type BackendReport,
} from "../backend/model.ts";
import type { AgentListResult, AgentReadResult } from "../run/agent-messaging.ts";
import { agentAttentionFact, agentReadCard, agentWorktreeFact } from "../tools/execute-agents.ts";
import { formatRunModel } from "../tools/format.ts";
import { subagentErrorCode, type SubagentError } from "../run/errors.ts";
import { clipWithMarker, reportFileText } from "../run/state.ts";
import {
  MAX_SUPERVISOR_AGENT_CARD_CHARS,
  MAX_SUPERVISOR_AGENT_FACT_CHARS,
  MAX_SUPERVISOR_AGENT_NAME_CHARS,
  MAX_SUPERVISOR_AGENT_READ_CHARS,
  SUPERVISOR_CHANNEL_VERSION,
  SupervisorAgentRefusal,
  type SupervisorAgentListResult,
  type SupervisorAgentReadResult,
  type SupervisorRpcFailure,
  SupervisorRpcGroup,
} from "../supervisor/protocol.ts";
import { eventQueueFull, rpcFailure } from "./supervisor-channel-errors.ts";
import {
  type AssignmentUpdate,
  authorize,
  authorizeAssignment,
  authorizePeer,
  failPendingQuestion,
  hasEventCapacity,
  offerContact,
  type PendingQuestion,
  refuseNativeSubAgent,
  type SupervisorChannelState,
  type SupervisorContactPayload,
  synchronizeReadiness,
} from "./supervisor-channel-state.ts";

const MAX_REPORT_DELIVERIES = 128;
const REPORT_EVIDENCE = `supervisor-effect-rpc-v${SUPERVISOR_CHANNEL_VERSION}`.slice(
  0,
  MAX_BACKEND_REPORT_EVIDENCE_CHARS,
);

const dispatchContact = (
  state: SupervisorChannelState,
  kind: "progress" | "warning",
  payload: SupervisorContactPayload,
  clientId: number,
): Effect.Effect<string, SupervisorRpcFailure> =>
  Effect.flatMap(
    authorizeAssignment(state, clientId, payload).pipe(
      Effect.andThen(refuseNativeSubAgent(state, payload)),
    ),
    () =>
      offerContact(state, kind, payload)
        ? Effect.succeed(
            kind === "progress"
              ? "Progress delivered to the parent projection."
              : "Warning recorded in parent-visible run status.",
          )
        : Effect.fail(eventQueueFull()),
  );

const agentMessaging = (
  state: SupervisorChannelState,
): Effect.Effect<BackendAgentMessaging, SupervisorRpcFailure> =>
  state.agents
    ? Effect.succeed(state.agents)
    : rpcFailure("agent_messaging_unavailable", "Agent messaging is unavailable for this run.");

const agentRefusal = (error: SubagentError) =>
  new SupervisorAgentRefusal({
    code: safeTextPrefix(subagentErrorCode(error), 128),
    message: safeTextPrefix(error.message.trim() || "The agent request was refused.", 512),
  });

const agentName = (name: string, id: string): string =>
  safeTextPrefix(name.trim() || id, MAX_SUPERVISOR_AGENT_NAME_CHARS);
const label = (value: string | undefined): string | undefined =>
  value?.trim() ? safeTextPrefix(value, MAX_SUPERVISOR_AGENT_NAME_CHARS) : undefined;
const fact = (value: string | undefined): string | undefined =>
  value?.trim() ? safeTextPrefix(value, MAX_SUPERVISOR_AGENT_FACT_CHARS) : undefined;

const wireAgentList = (result: AgentListResult): SupervisorAgentListResult => ({
  agents: result.agents.map((entry) => {
    const runtime = label(entry.runtime);
    const model = fact(entry.run && formatRunModel(entry.run));
    const profile = label(entry.profile);
    const agent = label(entry.agent);
    const worktree = fact(agentWorktreeFact(entry.run));
    const attention = fact(agentAttentionFact(entry.run));
    return {
      id: entry.id,
      name: agentName(entry.name, entry.id),
      kind: entry.kind,
      state: entry.state,
      ...(entry.parentId !== undefined && { parentId: entry.parentId }),
      ...(runtime !== undefined && { runtime }),
      ...(model !== undefined && { model }),
      ...(profile !== undefined && { profile }),
      ...(agent !== undefined && { agent }),
      ...(worktree !== undefined && { worktree }),
      ...(attention !== undefined && { attention }),
      self: entry.self,
    };
  }),
  missingIds: result.missingIds,
});

const wireAgentRead = (
  result: AgentReadResult,
  agents: BackendAgentMessaging,
  verbose: boolean,
): SupervisorAgentReadResult => ({
  agents: result.agents.map((entry) => {
    // A saved report leads with its file pointer, which the reader opens with its file tools.
    const reportFile = entry.kind === "run" ? entry.reportFile : undefined;
    const body = entry.textStatus === "text" ? entry.text : undefined;
    const pointer = reportFile && reportFileText(reportFile);
    const whole = pointer && body ? `${pointer}\n\nRetained copy:\n${body}` : (pointer ?? body);
    const text = whole && safeTextPrefix(whole, MAX_SUPERVISOR_AGENT_READ_CHARS);
    const source = entry.kind === "run" ? entry.source : undefined;
    const card =
      entry.kind === "run"
        ? clipWithMarker(
            agentReadCard(entry.run, { caller: agents.caller, parentCwd: agents.cwd, verbose }),
            MAX_SUPERVISOR_AGENT_CARD_CHARS,
            "\n… [status card truncated]",
          )
        : undefined;
    return {
      id: entry.id,
      name: agentName(entry.name, entry.id),
      state: entry.state,
      ...(card !== undefined && { card }),
      ...(text !== undefined && { text }),
      truncated: entry.truncated || (text !== undefined && text.length < (whole?.length ?? 0)),
      ...(source !== undefined && { source }),
    };
  }),
  missingIds: result.missingIds,
});

// The channel's own run is the caller; payloads authenticate it but never choose another identity.
const dispatchAgent = <A>(
  state: SupervisorChannelState,
  clientId: number,
  payload: Parameters<typeof authorizeAssignment>[2],
  call: (agents: BackendAgentMessaging) => Effect.Effect<A, SubagentError>,
  admit: Effect.Effect<void, SupervisorRpcFailure> = Effect.void,
): Effect.Effect<A, SupervisorRpcFailure | SupervisorAgentRefusal> =>
  authorizeAssignment(state, clientId, payload).pipe(
    Effect.andThen(admit),
    Effect.andThen(agentMessaging(state)),
    Effect.flatMap((agents) => call(agents).pipe(Effect.mapError(agentRefusal))),
  );

export const supervisorChannelHandlers = (state: SupervisorChannelState) =>
  SupervisorRpcGroup.toHandlers(
    SupervisorRpcGroup.of({
      SupervisorOpenSession: (payload, options) =>
        Effect.gen(function* () {
          const guard = yield* authorize(state, options.client.id, payload);
          if (!state.peers.has(options.client.id)) {
            const assignments = yield* Queue.bounded<AssignmentUpdate, Cause.Done>(4);
            state.peers.set(options.client.id, {
              clientId: options.client.id,
              guard,
              assignments,
              watching: false,
            });
          }
          return { assignmentEpoch: state.currentAssignmentEpoch };
        }),

      SupervisorWatchAssignments: (payload, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const peer = yield* authorizePeer(state, options.client.id, payload);
            if (peer.watching)
              return yield* rpcFailure(
                "assignment_watch_active",
                "This supervisor session already has an assignment stream.",
              );
            peer.watching = true;
            synchronizeReadiness(state);
            return Stream.fromQueue(peer.assignments).pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  peer.watching = false;
                  synchronizeReadiness(state);
                }),
              ),
            );
          }),
        ),

      SupervisorAcknowledgeAssignment: (payload, options) =>
        Effect.gen(function* () {
          yield* authorizePeer(state, options.client.id, payload);
          const acknowledgement = state.epochAcknowledgements.get(payload.updateId);
          if (
            !acknowledgement ||
            acknowledgement.peerId !== options.client.id ||
            acknowledgement.epoch !== payload.assignmentEpoch
          )
            return yield* rpcFailure(
              "assignment_epoch_ack_mismatch",
              "Assignment epoch acknowledgement did not match an issued update.",
            );
          state.epochAcknowledgements.delete(payload.updateId);
          if (state.pendingAssignmentEpoch === acknowledgement.epoch) {
            if (state.pendingQuestion && state.pendingQuestion.epoch < acknowledgement.epoch)
              failPendingQuestion(
                state,
                "question_assignment_advanced",
                "The pending supervisor question belonged to a prior assignment.",
              );
            state.currentAssignmentEpoch = acknowledgement.epoch;
            state.assignmentEpochs.add(acknowledgement.epoch);
          }
          Deferred.doneUnsafe(acknowledgement.firstAcknowledgement, Effect.void);
          return undefined;
        }),

      SupervisorProgress: (payload, options) =>
        dispatchContact(state, "progress", payload, options.client.id),
      SupervisorWarning: (payload, options) =>
        dispatchContact(state, "warning", payload, options.client.id),

      SupervisorQuestion: (payload, options) =>
        Effect.gen(function* () {
          yield* authorizeAssignment(state, options.client.id, payload);
          yield* refuseNativeSubAgent(state, payload);
          if (state.pendingQuestion)
            return yield* rpcFailure(
              "question_pending",
              "A blocking supervisor question is already pending.",
            );
          const pending: PendingQuestion = {
            requestId: payload.requestId,
            epoch: payload.assignmentEpoch,
            peerId: options.client.id,
            response: Deferred.makeUnsafe(),
            acknowledgement: Deferred.makeUnsafe(),
            replyStarted: false,
          };
          state.pendingQuestion = pending;
          if (!offerContact(state, "question", payload)) {
            state.pendingQuestion = undefined;
            return yield* eventQueueFull();
          }
          return yield* Deferred.await(pending.response).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (
                  Exit.isFailure(exit) &&
                  state.pendingQuestion === pending &&
                  !pending.replyStarted
                )
                  failPendingQuestion(
                    state,
                    "question_cancelled",
                    "The supervisor question call was cancelled.",
                  );
              }),
            ),
          );
        }),

      SupervisorAcknowledgeQuestionReply: (payload, options) =>
        Effect.gen(function* () {
          yield* authorize(state, options.client.id, payload);
          const pending = state.pendingQuestion;
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
          state.pendingQuestion = undefined;
          Deferred.doneUnsafe(pending.acknowledgement, Effect.void);
          return undefined;
        }),

      SupervisorReport: (payload, options) =>
        Effect.gen(function* () {
          yield* authorizeAssignment(state, options.client.id, payload);
          yield* refuseNativeSubAgent(state, payload);
          const previous = state.reports.get(payload.deliveryId);
          if (previous) {
            if (
              previous.assignmentEpoch !== payload.assignmentEpoch ||
              previous.text !== payload.text
            )
              return yield* rpcFailure(
                "delivery_identity_conflict",
                "The report delivery identity was already used for different evidence.",
              );
            return {
              duplicate: true,
              sequence: previous.sequence,
              assignmentEpoch: previous.assignmentEpoch,
            };
          }
          if (state.reports.size >= MAX_REPORT_DELIVERIES)
            return yield* rpcFailure(
              "report_identity_capacity",
              "The report delivery identity map is full.",
            );
          const sequence = state.nextReportSequence;
          const report: BackendReport & { readonly type: "report" } = {
            type: "report",
            runId: state.runId,
            assignmentEpoch: payload.assignmentEpoch,
            sequence,
            deliveryId: payload.deliveryId,
            text: payload.text,
            evidence: REPORT_EVIDENCE,
          };
          const cancelsQuestion =
            state.pendingQuestion !== undefined &&
            state.pendingQuestion.epoch <= payload.assignmentEpoch;
          if (
            !hasEventCapacity(state, state.pendingQuestion === undefined ? 1 : 2) ||
            !Queue.offerUnsafe(state.events, report)
          )
            return yield* eventQueueFull();
          if (cancelsQuestion)
            failPendingQuestion(
              state,
              "question_cancelled_by_report",
              "The pending question was cancelled because its assignment report was accepted.",
            );
          state.reports.set(payload.deliveryId, report);
          state.nextReportSequence += 1;
          return { duplicate: false, sequence, assignmentEpoch: payload.assignmentEpoch };
        }),

      SupervisorAgentList: (payload, options) =>
        dispatchAgent(state, options.client.id, payload, (agents) =>
          agents.list(payload.ids).pipe(Effect.map(wireAgentList)),
        ),

      SupervisorAgentSend: (payload, options) =>
        dispatchAgent(
          state,
          options.client.id,
          payload,
          (agents) =>
            agents.send(payload.to, payload.message).pipe(
              Effect.map((sent) => ({
                messageId: sent.messageId,
                to: sent.to,
                name: agentName(sent.name, sent.to),
                disposition: sent.disposition,
                confirmed: sent.confirmed,
                ...(sent.mainState !== undefined && { mainState: sent.mainState }),
                ...(sent.parked && { parked: true as const }),
              })),
            ),
          refuseNativeSubAgent(state, payload),
        ),

      SupervisorAgentRead: (payload, options) =>
        dispatchAgent(state, options.client.id, payload, (agents) =>
          agents
            .read(payload.ids)
            .pipe(Effect.map((result) => wireAgentRead(result, agents, payload.verbose === true))),
        ),
    }),
  );
