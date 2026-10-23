import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
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
  messageSizeError,
  planRunMessage,
  planUserMessage,
  runListEntry,
  runReadout,
  runSender,
  startingTargetRefusal,
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
  type SubagentRuntimeClosedError,
} from "./errors.ts";
import { snapshotRun, type RunContext, type RunRecord } from "./internal.ts";
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
  /** The published projection's revision; every run state change publishes a newer one. */
  readonly revision: Effect.Effect<number>;
  readonly waitForRevision: (after: number) => Effect.Effect<void, SubagentRuntimeClosedError>;
}

/** How long a message waits for its target to leave `starting` before it is refused. */
const STARTING_TARGET_WAIT = Duration.seconds(5);

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

/** A claim either admits the message or finds its target still starting. */
type SendClaim = ClaimedSend | { readonly kind: "starting" };

const deliverToMain = Effect.fn("SubagentMessages.deliverToMain")(function* (
  claimed: Extract<ClaimedSend, { kind: "main" }>,
  frame: Parameters<AgentMainCapabilities["deliver"]>[0],
) {
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
    return record
      ? Effect.succeed(runSender(snapshotRun(record)))
      : Effect.fail(runNotFound(caller.runId));
  };

  const readMain = (): AgentMainReadout | undefined =>
    main
      ? invokeHostCallback<AgentMainReadout | undefined>(() => main.read(), undefined)
      : undefined;

  const list = Effect.fn("SubagentMessages.list")(function* (
    caller: AgentCaller,
    ids?: ReadonlyArray<string>,
  ): Effect.fn.Return<AgentListResult, SubagentError> {
    const selected = ids === undefined ? undefined : yield* validateTargets(ids);
    const mainState =
      selected === undefined || selected.includes(MAIN_AGENT_ID)
        ? (readMain()?.state ?? "unavailable")
        : "unavailable";
    return yield* withLock(
      Effect.gen(function* () {
        const sender = yield* resolveSenderLocked(caller);
        const runs = sortRuns(projectRunTree(records)).map((view) => runListEntry(view, sender.id));
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
  const read = Effect.fn("SubagentMessages.read")(function* (
    caller: AgentCaller,
    ids: ReadonlyArray<string>,
  ): Effect.fn.Return<AgentReadResult, SubagentError> {
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

  // A run that is starting takes messages once it runs, so a send waits a few seconds for it
  // instead of refusing at once. The revision is read before the state, so a change between them
  // still wakes the wait. The wait holds nothing and ends when the sender is interrupted.
  const waitWhileStarting = Effect.fn("SubagentMessages.waitWhileStarting")(
    function* (id: string) {
      while (true) {
        const observed = yield* dependencies.revision;
        if (!(yield* withLock(Effect.sync(() => records.get(id)?.view.state === "starting"))))
          return;
        yield* dependencies.waitForRevision(observed);
      }
    },
    Effect.timeoutOption(STARTING_TARGET_WAIT),
    Effect.asVoid,
  );

  const claimSend = (caller: AgentCaller, to: string, text: string) =>
    withLock(
      Effect.gen(function* (): Effect.fn.Return<SendClaim, SubagentError> {
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
          const tooLarge = messageSizeError("main", text);
          if (tooLarge) return yield* tooLarge;
          return { kind: "main", sender, main };
        }
        const record = yield* requireTargetLocked(to);
        const plan = planRunMessage(records, record, sender.id);
        if (plan.kind === "refuse") return yield* agentMessageRefusal(plan.code, plan.message);
        const tooLarge = messageSizeError(plan.kind, text);
        if (tooLarge) return yield* tooLarge;
        if (plan.kind === "starting") return plan;
        return { kind: plan.kind, sender, record };
      }),
    );

  const claimUserSend = (
    to: string,
    expected: SubagentControlExpectation | undefined,
    text: string,
  ) =>
    withLock(
      Effect.gen(function* (): Effect.fn.Return<SendClaim, SubagentError> {
        const record = yield* requireTargetLocked(to);
        yield* requireControlExpectation(record, expected);
        const plan = planUserMessage(records, record);
        if (plan.kind === "refuse") return yield* agentMessageRefusal(plan.code, plan.message);
        const tooLarge = messageSizeError(plan.kind, text);
        if (tooLarge) return yield* tooLarge;
        if (plan.kind === "starting") return plan;
        return { kind: plan.kind, sender: undefined, record, expected };
      }),
    );

  const recordSentLocked = Effect.fn("SubagentMessages.recordSentLocked")(function* (
    sender: AgentSender,
    to: string,
    text: string,
    now: number,
  ) {
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
                  const run = snapshotRun(record);
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

  const commitSend = Effect.fn("SubagentMessages.commitSend")(function* (
    claimed: ClaimedSend,
    to: string,
    text: string,
    messageId: string,
  ): Effect.fn.Return<AgentSendResult, SubagentError> {
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

  // The claim admits the message under the run lock, so a send that would be refused is refused
  // before any wait; once admitted, delivery commits in the session scope so a cancelled sender
  // never abandons it halfway.
  const deliver = (
    message: string,
    to: string,
    claim: (text: string) => Effect.Effect<SendClaim, SubagentError>,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    validateMessageText(message).pipe(
      Effect.flatMap((text) =>
        Effect.gen(function* () {
          let claimed = yield* claim(text);
          if (claimed.kind === "starting") {
            yield* waitWhileStarting(to);
            claimed = yield* claim(text);
          }
          if (claimed.kind === "starting") return yield* startingTargetRefusal(to);
          return yield* runSessionOwned(ownerScope, Effect.succeed(claimed), (admitted) =>
            commitSend(admitted, to, text, dependencies.allocateMessageId()),
          );
        }),
      ),
    );

  const send = (
    caller: AgentCaller,
    rawTo: string,
    message: string,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    Effect.suspend(() => {
      const to = rawTo.trim();
      return deliver(message, to, (text) => claimSend(caller, to, text));
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
    deliver(message, id, (text) => claimUserSend(id, expected, text));

  return { list, read, send, sendFromUser };
}
