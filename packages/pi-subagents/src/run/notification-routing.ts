import { hasObjectRuntimeType, invokeHostCallback } from "pi-cosmic-core";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  completionBlock,
  inlineCompletionReport,
  type SubagentNotification,
  type SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import { indentQuestionLines } from "../tools/format.ts";
import { formatRunBlock, withInlineReports } from "../tools/run-block.ts";
import { completionNotificationKey, deliveredCompletionKeys } from "./completion.ts";
import { isOutcomeUncertain } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "./limits.ts";
import { isActiveRunState, SUBAGENT_ROOT_RUN_ID } from "./model.ts";
import { sanitizeOutputText } from "./state.ts";

interface RunNotificationRoutingDependencies extends Pick<RunContext, "records" | "withLock"> {
  readonly admitTurnInput: (record: RunRecord) => void;
  readonly releaseTurnInput: (record: RunRecord) => Effect.Effect<void>;
  readonly notifyHost: (
    notification: SubagentNotification,
  ) => SubagentNotificationDelivery | undefined | void;
}

const ancestorMessage = (notification: SubagentNotification): string => {
  if (notification.type === "question")
    return sanitizeOutputText(
      `Descendant ${notification.name} (${notification.id}) is waiting for a reply.\n\nQuestion:\n${indentQuestionLines(notification.message, "  ")}\n\nIf it isn't answered yet, answer with agent_send({ to: "${notification.id}", message: "..." }).`,
      32 * 1024,
    );
  const run = notification.runs[0];
  if (!run) return "A descendant subagent finished.";
  // The same bounded block a root notice shows, so it always fits the parent message, and the
  // whole report when it fits too.
  return sanitizeOutputText(
    withInlineReports(
      `Descendant subagent ${run.outcome === "failed" ? "failed" : "reported"}.\n\n${formatRunBlock(completionBlock(run))}\n\nUse agent_read for the full run record.`,
      [inlineCompletionReport(run)],
      MAX_PARENT_MESSAGE_CHARS,
    ),
    MAX_PARENT_MESSAGE_CHARS,
  );
};

const canAcceptNotification = (record: RunRecord): boolean =>
  isActiveRunState(record.view.state) &&
  record.view.state !== "paused" &&
  record.view.state !== "stopping" &&
  !record.stoppedByParent &&
  !record.pauseRequested &&
  record.process?.controls.deliverNotification !== undefined;

/** Pi ancestors that can take a notification about `sourceRunId`, nearest first. */
const notifiableAncestors = (
  records: ReadonlyMap<string, RunRecord>,
  sourceRunId: string,
): ReadonlyArray<RunRecord> => {
  let parentRunId = records.get(sourceRunId)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
  const candidates: RunRecord[] = [];
  while (parentRunId !== SUBAGENT_ROOT_RUN_ID) {
    const parent = records.get(parentRunId);
    if (!parent) break;
    if (parent.view.runtime === "pi" && canAcceptNotification(parent)) candidates.push(parent);
    parentRunId = parent.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
  }
  return candidates;
};

/** The run that a question from `sourceRunId` reaches first; undefined for the root session. */
export const questionRecipientRunId = (
  records: ReadonlyMap<string, RunRecord>,
  sourceRunId: string,
): string | undefined => notifiableAncestors(records, sourceRunId)[0]?.view.id;

export function notificationRouter(dependencies: RunNotificationRoutingDependencies) {
  const { records, withLock, admitTurnInput, releaseTurnInput, notifyHost } = dependencies;

  const notifyRoot = (
    notification: SubagentNotification,
  ): SubagentNotificationDelivery | undefined => {
    const delivered = invokeHostCallback<SubagentNotificationDelivery | undefined | void>(
      () => notifyHost(notification),
      notification.type === "completed"
        ? { deliveredCompletionKeys: [] }
        : { actionAccepted: false },
    );
    return hasObjectRuntimeType(delivered) && delivered !== null ? delivered : undefined;
  };
  const deliverToNearestAncestor = (
    sourceRunId: string,
    message: string,
    key: string,
  ): Effect.Effect<boolean | "uncertain"> =>
    Effect.suspend(() => {
      const candidates = notifiableAncestors(records, sourceRunId);
      const attempt = (index: number): Effect.Effect<boolean | "uncertain"> => {
        const candidate = candidates[index];
        if (!candidate) return Effect.succeed(false);
        return Effect.acquireUseRelease(
          withLock(
            Effect.sync(() => {
              const current = records.get(candidate.view.id);
              const deliverNotification = current?.process?.controls.deliverNotification;
              if (current !== candidate || !deliverNotification || !canAcceptNotification(current))
                return undefined;
              admitTurnInput(current);
              return { record: current, deliverNotification };
            }),
          ),
          (admission) =>
            admission
              ? admission.deliverNotification(message, key).pipe(Effect.as(true))
              : Effect.succeed(false),
          (admission) => (admission ? releaseTurnInput(admission.record) : Effect.void),
        ).pipe(
          Effect.flatMap((delivered) => (delivered ? Effect.succeed(true) : attempt(index + 1))),
          Effect.catchTag("SubagentProcessError", (error) =>
            isOutcomeUncertain(error) ? Effect.succeed("uncertain" as const) : attempt(index + 1),
          ),
          // `attempt` cannot fail, so this only sees the remaining delivery errors.
          Effect.catch(() => attempt(index + 1)),
        );
      };
      return attempt(0);
    });
  return (
    notification: SubagentNotification,
  ): Effect.Effect<SubagentNotificationDelivery | undefined> => {
    if (
      notification.type === "completed" &&
      Arr.every(
        notification.runs,
        (run) =>
          (records.get(run.id)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID,
      )
    )
      return Effect.succeed(notifyRoot(notification));
    if (notification.type === "question")
      return deliverToNearestAncestor(
        notification.id,
        ancestorMessage(notification),
        `${notification.id}:question:${notification.generation}`,
      ).pipe(
        Effect.map((delivered) =>
          delivered === "uncertain"
            ? { actionAccepted: false }
            : delivered
              ? { actionAccepted: true }
              : notifyRoot(notification),
        ),
      );
    return Effect.forEach(
      notification.runs,
      (run) =>
        deliverToNearestAncestor(
          run.id,
          ancestorMessage({ type: "completed", runs: [run] }),
          completionNotificationKey(run.id, run.generation),
        ).pipe(
          Effect.map((delivered) => {
            const key = completionNotificationKey(run.id, run.generation);
            // An uncertain send stays unacknowledged for retry, never falling through to the root.
            if (delivered === "uncertain") return undefined;
            if (delivered) return key;
            const runs = [run];
            const rootDelivery = notifyRoot({ type: "completed", runs });
            return deliveredCompletionKeys(rootDelivery, runs).has(key) ? key : undefined;
          }),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((keys) => ({
        deliveredCompletionKeys: Arr.filter(keys, Predicate.isNotUndefined),
      })),
    );
  };
}
