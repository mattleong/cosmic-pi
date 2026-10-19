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
  MAX_AGENT_MESSAGE_CHARS,
  MAX_AGENT_TARGETS,
  planRunMessage,
  runListEntry,
  runReadout,
  runSender,
  unavailableMainReadout,
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
import type { AgentMessageResume } from "./resume.ts";
import type { SubagentRunView, SubagentSendOutcome } from "./model.ts";
import { sortRuns } from "./projection.ts";
import { appendMessageSessionEvent } from "./session-events.ts";
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
  ) => Effect.Effect<SubagentSendOutcome, SubagentError>;
  readonly resume: (
    id: string,
    message: string,
    agentMessage: AgentMessageResume,
  ) => Effect.Effect<SubagentRunView, SubagentError>;
  readonly allocateMessageId: () => string;
}

const validateAgentMessage = (
  message: string,
): Effect.Effect<string, InvalidSubagentRequestError> => {
  const normalized = message.trim();
  if (!normalized) return Effect.fail(invalidRequest("message_required", "Message is required."));
  if (normalized.length > MAX_AGENT_MESSAGE_CHARS)
    return Effect.fail(
      invalidRequest(
        "message_too_large",
        `Agent message exceeds ${MAX_AGENT_MESSAGE_CHARS.toLocaleString("en-US")} characters.`,
      ),
    );
  return Effect.succeed(normalized);
};

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
  };
};

type ClaimedSend =
  | { readonly kind: "main"; readonly sender: AgentSender; readonly main: AgentMainCapabilities }
  | {
      readonly kind: "answer" | "guide" | "resume";
      readonly sender: AgentSender;
      readonly record: RunRecord;
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
    return { disposition };
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
        const record = records.get(to);
        if (!record)
          return yield* agentMessageRefusal(
            "agent_not_found",
            `Agent ${to} is not in this session; call agent_list for current agent IDs.`,
          );
        const plan = planRunMessage(records, record, sender.id);
        if (plan.kind === "refuse") return yield* agentMessageRefusal(plan.code, plan.message);
        return { kind: plan.kind, sender, record };
      }),
    );

  const recordSentLocked = (sender: AgentSender, to: string, text: string, now: number) =>
    Effect.gen(function* () {
      const record = sender.id === MAIN_AGENT_ID ? undefined : records.get(sender.id);
      if (!record) return;
      recordMessageLocked(record, "out", to, text, now);
      yield* publish;
    });

  const commitSend = (
    claimed: ClaimedSend,
    to: string,
    text: string,
    messageId: string,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    Effect.gen(function* () {
      const { sender } = claimed;
      const content = agentMessageContent(sender, text);
      const recordReceived = (record: RunRecord, now: number) =>
        recordMessageLocked(record, "in", sender.id, text, now);
      let delivered: Omit<AgentSendResult, "messageId" | "to">;
      if (claimed.kind === "main") {
        delivered = {
          name: MAIN_AGENT_ID,
          ...(yield* deliverToMain(claimed, {
            messageId,
            from: sender.id,
            fromName: sender.name,
            to,
            content,
          })),
        };
      } else if (claimed.kind === "resume") {
        const run = yield* dependencies.resume(to, content, {
          resumedBy: sender.label,
          recordNoticeLocked: recordReceived,
        });
        delivered = { name: run.name, disposition: "resumed", run };
      } else {
        const { record } = claimed;
        // Guidance still being confirmed may already have arrived, so it is reported, not failed,
        // and recorded on the receiver as the sender records it.
        delivered = yield* dependencies
          .deliverToRun(to, {
            ...(claimed.kind === "answer" && { answer: text }),
            guidance: content,
            recordNoticeLocked: (received, _delivery, now) => recordReceived(received, now),
          })
          .pipe(
            Effect.map(
              (outcome): Omit<AgentSendResult, "messageId" | "to"> => ({
                name: outcome.run.name,
                disposition: outcome.delivery,
                run: outcome.run,
              }),
            ),
            Effect.catchIf(isPendingSteerDelivery, () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  withLock(
                    Effect.suspend(() => {
                      recordReceived(record, now);
                      return publish;
                    }),
                  ),
                ),
                Effect.as({ name: record.view.name, disposition: "pending" as const }),
              ),
            ),
          );
      }
      const now = yield* Clock.currentTimeMillis;
      yield* withLock(recordSentLocked(sender, to, text, now));
      return { messageId, to, ...delivered };
    });

  // The claim admits the message under the run lock; once admitted, delivery commits in the
  // session scope so a cancelled sender never abandons it halfway.
  const send = (
    caller: AgentCaller,
    rawTo: string,
    message: string,
  ): Effect.Effect<AgentSendResult, SubagentError> =>
    Effect.gen(function* () {
      const text = yield* validateAgentMessage(message);
      const to = rawTo.trim();
      return yield* runSessionOwned(ownerScope, claimSend(caller, to), (claimed) =>
        commitSend(claimed, to, text, dependencies.allocateMessageId()),
      );
    });

  return { list, read, send };
}
