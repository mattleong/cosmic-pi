import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  agentMessageContent,
  type AgentCaller,
  type AgentListResult,
  type AgentMainCapabilities,
  type AgentMainReadout,
  type AgentReadResult,
  type AgentSender,
  type AgentSendResult,
  MAIN_AGENT_ID,
  MAIN_AGENT_SENDER,
  mainListEntry,
  mainReadout,
  MAX_AGENT_TARGETS,
  planRunMessage,
  planUserMessage,
  runListEntry,
  runReadout,
  runSender,
  unavailableMainReadout,
  validateMessageText,
} from "./agent-messaging.ts";
import {
  agentMessageRefusal,
  invalidRequest,
  isPendingSteerDelivery,
  type InvalidSubagentRequestError,
  runNotFound,
  type SubagentError,
  type SubagentNotFoundError,
} from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import type { RunControlMessage } from "./control.ts";
import { requireControlExpectation } from "./control-admission.ts";
import type { AgentMessageResume } from "./resume.ts";
import type {
  SubagentControlExpectation,
  SubagentRunView,
  SubagentSendDelivery,
  SubagentSendOutcome,
} from "./model.ts";
import { sortRuns } from "./projection.ts";
import { snapshotView } from "./state.ts";
import { appendMessageSessionEvent, appendNoticeSessionEvent } from "./session-events.ts";
import { runSessionOwned } from "./session-owned.ts";
import { projectRunTree } from "./tree.ts";

interface AgentMessageDependencies extends Pick<
  RunContext,
  "ownerScope" | "withLock" | "publish" | "records"
> {
  readonly main?: AgentMainCapabilities | undefined;
  readonly deliverToRun: (
    id: string,
    message: RunControlMessage,
    expected?: SubagentControlExpectation,
  ) => Effect.Effect<SubagentSendOutcome, SubagentError>;
  readonly resume: (
    id: string,
    agentMessage: AgentMessageResume,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly allocateMessageId: () => string;
}

// IDs are trimmed like the call headings that show them, so " main" still names main.
const validateTargets = (
  ids: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, InvalidSubagentRequestError> => {
  const unique = [...new Set(ids.map((id) => id.trim()))];
  return unique.length > MAX_AGENT_TARGETS
    ? Effect.fail(
        invalidRequest(
          "too_many_targets",
          `Name at most ${MAX_AGENT_TARGETS} agents at once, or omit the IDs to list every agent.`,
        ),
      )
    : Effect.succeed(unique);
};

const recordMessageLocked = (
  record: RunRecord,
  direction: "in" | "out",
  peer: string,
  text: string,
  now: number,
) => {
  record.view = {
    ...record.view,
    lastActivityAt: now,
    sessionEvents: appendMessageSessionEvent(record.view.sessionEvents, direction, peer, text, now),
    messageCount: Math.min(Number.MAX_SAFE_INTEGER, (record.view.messageCount ?? 0) + 1),
  };
};

// Guidance that steers a turn blocked on the run's own question waits behind that question.
const parked = (delivery: SubagentSendDelivery, run: SubagentRunView): boolean =>
  delivery === "guided" && run.state === "waiting_for_parent";

// The user's messages show as parent notices, apart from the agent messages a run counts.
const recordUserMessageLocked = (
  record: RunRecord,
  delivery: SubagentSendDelivery,
  text: string,
  now: number,
) => {
  record.view = {
    ...record.view,
    lastActivityAt: now,
    sessionEvents: appendNoticeSessionEvent(
      record.view.sessionEvents,
      "parent",
      `${delivery === "answered" ? "Reply" : "Guidance"}: ${text}`,
      now,
    ),
  };
};

type ClaimedSend =
  | { readonly kind: "main"; readonly sender: AgentSender; readonly main: AgentMainCapabilities }
  | { readonly kind: "resume"; readonly sender: AgentSender; readonly record: RunRecord }
  | {
      readonly kind: "answer" | "guide";
      /** The sending agent, or undefined for the user, whose messages arrive as bare text. */
      readonly sender: AgentSender | undefined;
      readonly record: RunRecord;
      /** The run as the user saw it; the message applies only while it is unchanged. */
      readonly expected?: SubagentControlExpectation | undefined;
    };

const deliverToMain = (
  claimed: Extract<ClaimedSend, { kind: "main" }>,
  frame: Parameters<AgentMainCapabilities["deliver"]>[0],
) =>
  Effect.gen(function* () {
    const disposition = yield* Effect.sync(() =>
      invokeHostCallback(() => claimed.main.deliver(frame), "unavailable" as const),
    );
    if (disposition === "unavailable")
      return yield* agentMessageRefusal(
        "agent_unavailable",
        "The main agent's session is no longer accepting messages.",
      );
    return { disposition: "guided" as const, confirmed: true, mainState: disposition };
  });

/**
 * `agent_*` messaging: any authenticated agent reaches every agent in the root tree plus `main`.
 * Messages are delivered when sent; nothing waits in a mailbox.
 */
export function agentMessageOperations(dependencies: AgentMessageDependencies) {
  const { ownerScope, withLock, publish, records, main } = dependencies;

  // Only the root binds the caller, so a run cannot speak as another agent.
  const resolveSenderLocked = (
    caller: AgentCaller,
  ): Effect.Effect<AgentSender, SubagentNotFoundError> => {
    if (caller.kind === "main") return Effect.succeed(MAIN_AGENT_SENDER);
    const record = records.get(caller.runId);
    return record ? Effect.succeed(runSender(record.view)) : Effect.fail(runNotFound(caller.runId));
  };

  const readMain = (): AgentMainReadout | undefined =>
    main
      ? invokeHostCallback<AgentMainReadout | undefined>(() => main.read(), undefined)
      : undefined;

  const list = (
    caller: AgentCaller,
    ids?: ReadonlyArray<string>,
  ): Effect.Effect<AgentListResult, SubagentError> =>
    Effect.gen(function* () {
      const selected = ids === undefined ? undefined : yield* validateTargets(ids);
      const mainState =
        selected === undefined || selected.includes(MAIN_AGENT_ID)
          ? (readMain()?.state ?? "unavailable")
          : "unavailable";
      return yield* withLock(
        Effect.gen(function* () {
          const sender = yield* resolveSenderLocked(caller);
          const runs = sortRuns(projectRunTree(records)).map((view) =>
            runListEntry(view, sender.id),
          );
          const everyone = [mainListEntry(mainState, sender.id), ...runs];
          if (selected === undefined) return { agents: everyone, missingIds: [] };
          return {
            agents: everyone.filter((entry) => selected.includes(entry.id)),
            missingIds: selected.filter((id) => !everyone.some((entry) => entry.id === id)),
          };
        }),
      );
    });

  // Reads never claim or consume a report, so the parent's delivery is unaffected.
  const read = (
    caller: AgentCaller,
    ids: ReadonlyArray<string>,
  ): Effect.Effect<AgentReadResult, SubagentError> =>
    Effect.gen(function* () {
      const selected = yield* validateTargets(ids);
      if (selected.length === 0)
        return yield* invalidRequest("agent_ids_required", "Name at least one agent to read.");
      const mainRead = selected.includes(MAIN_AGENT_ID) ? readMain() : undefined;
      return yield* withLock(
        Effect.gen(function* () {
          yield* resolveSenderLocked(caller);
          const views = new Map(projectRunTree(records).map((view) => [view.id, view]));
          const agents: Array<AgentReadResult["agents"][number]> = [];
          const missingIds: string[] = [];
          for (const id of selected) {
            const record = id === MAIN_AGENT_ID ? undefined : records.get(id);
            const view = views.get(id);
            if (record && view) agents.push(runReadout(record, view));
            else if (id === MAIN_AGENT_ID)
              agents.push(mainRead ? mainReadout(mainRead) : unavailableMainReadout);
            else missingIds.push(id);
          }
          return { agents, missingIds };
        }),
      );
    });

  const requireTargetLocked = (to: string) => {
    const record = records.get(to);
    return record
      ? Effect.succeed(record)
      : Effect.fail(
          agentMessageRefusal(
            "agent_not_found",
            `Agent ${to} is not in this session; call agent_list for current agent IDs.`,
          ),
        );
  };

  const claimSend = (caller: AgentCaller, to: string) =>
    withLock(
      Effect.gen(function* (): Effect.fn.Return<ClaimedSend, SubagentError> {
        const sender = yield* resolveSenderLocked(caller);
        if (to === sender.id)
          return yield* agentMessageRefusal(
            "agent_self_target",
            "An agent cannot message itself; name another agent from agent_list.",
          );
        if (to === MAIN_AGENT_ID) {
          if (!main)
            return yield* agentMessageRefusal(
              "agent_unavailable",
              "The main agent cannot receive agent messages in this session.",
            );
          return { kind: "main", sender, main };
        }
        const record = yield* requireTargetLocked(to);
        const plan = planRunMessage(records, record, sender.id);
        if (plan.kind === "refuse") return yield* agentMessageRefusal(plan.code, plan.message);
        return { kind: plan.kind, sender, record };
      }),
    );

  const claimUserSend = (to: string, expected: SubagentControlExpectation | undefined) =>
    withLock(
      Effect.gen(function* (): Effect.fn.Return<ClaimedSend, SubagentError> {
        const record = yield* requireTargetLocked(to);
        yield* requireControlExpectation(record, expected);
        const plan = planUserMessage(records, record);
        if (plan.kind === "refuse") return yield* agentMessageRefusal(plan.code, plan.message);
        return { kind: plan.kind, sender: undefined, record, expected };
      }),
    );

  const recordSentLocked = (sender: AgentSender, to: string, text: string, now: number) =>
    Effect.gen(function* () {
      const record = sender.id === MAIN_AGENT_ID ? undefined : records.get(sender.id);
      if (!record) return;
      recordMessageLocked(record, "out", to, text, now);
      yield* publish;
    });

  const deliverRunMessage = (
    claimed: Extract<ClaimedSend, { kind: "answer" | "guide" }>,
    to: string,
    text: string,
  ): Effect.Effect<Omit<AgentSendResult, "messageId" | "to">, SubagentError> => {
    const { sender, record } = claimed;
    const recordReceived = (received: RunRecord, delivery: SubagentSendDelivery, now: number) =>
      sender
        ? recordMessageLocked(received, "in", sender.id, text, now)
        : recordUserMessageLocked(received, delivery, text, now);
    // Guidance still being confirmed may already have arrived, so it is reported, not failed,
    // and recorded on the receiver as the sender records it.
    return dependencies
      .deliverToRun(
        to,
        {
          ...(claimed.kind === "answer" && { answer: text }),
          guidance: sender ? agentMessageContent(sender, text) : text,
          recordNoticeLocked: recordReceived,
        },
        claimed.expected,
      )
      .pipe(
        Effect.map(
          (outcome): Omit<AgentSendResult, "messageId" | "to"> => ({
            name: outcome.run.name,
            disposition: outcome.delivery,
            confirmed: true,
            ...(parked(outcome.delivery, outcome.run) && { parked: true }),
            run: outcome.run,
          }),
        ),
        Effect.catchIf(isPendingSteerDelivery, () =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              withLock(
                Effect.gen(function* () {
                  recordReceived(record, "guided", now);
                  yield* publish;
                  const run = snapshotView(record.view);
                  return {
                    name: run.name,
                    disposition: "guided" as const,
                    confirmed: false,
                    ...(parked("guided", run) && { parked: true as const }),
                    run,
                  };
                }),
              ),
            ),
          ),
        ),
      );
  };

  const commitSend = (
    claimed: ClaimedSend,
    to: string,
    text: string,
    messageId: string,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    Effect.gen(function* () {
      let delivered: Omit<AgentSendResult, "messageId" | "to">;
      if (claimed.kind === "main") {
        const { sender } = claimed;
        delivered = {
          name: MAIN_AGENT_ID,
          ...(yield* deliverToMain(claimed, {
            messageId,
            from: sender.id,
            fromName: sender.name,
            to,
            content: agentMessageContent(sender, text),
          })),
        };
      } else if (claimed.kind === "resume") {
        const { sender } = claimed;
        const run = yield* dependencies.resume(to, {
          prompt: agentMessageContent(sender, text),
          resumedBy: sender.label,
          recordNoticeLocked: (record, now) =>
            recordMessageLocked(record, "in", sender.id, text, now),
        });
        delivered = { name: run.name, disposition: "resumed", confirmed: true, run };
      } else delivered = yield* deliverRunMessage(claimed, to, text);
      const { sender } = claimed;
      if (sender) {
        const now = yield* Clock.currentTimeMillis;
        yield* withLock(recordSentLocked(sender, to, text, now));
      }
      return { messageId, to, ...delivered };
    });

  // The claim admits the message under the run lock; once admitted, delivery commits in the
  // session scope so a cancelled sender never abandons it halfway.
  const deliver = (
    message: string,
    to: string,
    claim: Effect.Effect<ClaimedSend, SubagentError>,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    validateMessageText(message).pipe(
      Effect.flatMap((text) =>
        runSessionOwned(ownerScope, claim, (claimed) =>
          commitSend(claimed, to, text, dependencies.allocateMessageId()),
        ),
      ),
    );

  const send = (
    caller: AgentCaller,
    rawTo: string,
    message: string,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    Effect.suspend(() => {
      const to = rawTo.trim();
      return deliver(message, to, claimSend(caller, to));
    });

  /**
   * The user's message from Activity or the fleet, delivered like an agent's but as bare text: it
   * answers a waiting run or steers a running one, never resumes one, and applies only while the
   * run is as `expected` captured it.
   */
  const sendFromUser = (
    id: string,
    message: string,
    expected?: SubagentControlExpectation,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    deliver(message, id, claimUserSend(id, expected));

  return { list, read, send, sendFromUser };
}
