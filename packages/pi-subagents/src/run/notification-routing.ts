import { hasObjectRuntimeType, invokeHostCallback } from "pi-cosmic-core";
import * as Effect from "effect/Effect";
import type {
  SubagentNotification,
  SubagentNotificationDelivery,
} from "../boundary/host-notifier.ts";
import { completionNotificationKey, deliveredCompletionKeys } from "./completion.ts";
import { isOutcomeUncertain } from "./errors.ts";
import type { RunContext, RunRecord } from "./internal.ts";
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
      `Descendant ${notification.name} (${notification.id}) is waiting for a reply.\n\nQuestion: ${notification.message}\n\nUse subagent_reply for ${notification.id}.`,
      32 * 1024,
    );
  const run = notification.runs[0];
  if (!run) return "A descendant subagent finished.";
  const outcome =
    run.outcome === "failed"
      ? `failed: ${run.error ?? "No failure detail."}`
      : `reported: ${run.finalText ?? "No final report."}`;
  return sanitizeOutputText(
    `Descendant ${run.name} (${run.id}) ${outcome}\n\nUse subagent_status or subagent_await for the full run record.`,
    32 * 1024,
  );
};

const canAcceptNotification = (record: RunRecord): boolean =>
  isActiveRunState(record.view.state) &&
  record.view.state !== "paused" &&
  !record.pauseRequested &&
  record.process?.controls.deliverNotification !== undefined;

export function makeRunNotificationRouting(dependencies: RunNotificationRoutingDependencies) {
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
  ): Effect.Effect<boolean | "uncertain"> =>
    Effect.suspend(() => {
      let parentRunId = records.get(sourceRunId)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      const candidates: RunRecord[] = [];
      while (parentRunId !== SUBAGENT_ROOT_RUN_ID) {
        const parent = records.get(parentRunId);
        if (!parent) break;
        if (parent.view.runtime === "pi" && canAcceptNotification(parent)) candidates.push(parent);
        parentRunId = parent.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID;
      }
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
              ? admission.deliverNotification(message).pipe(Effect.as(true))
              : Effect.succeed(false),
          (admission) => (admission ? releaseTurnInput(admission.record) : Effect.void),
        ).pipe(
          Effect.flatMap((delivered) => (delivered ? Effect.succeed(true) : attempt(index + 1))),
          Effect.catch((error) =>
            error._tag === "SubagentProcessError" && isOutcomeUncertain(error)
              ? Effect.succeed("uncertain" as const)
              : attempt(index + 1),
          ),
        );
      };
      return attempt(0);
    });
  return (
    notification: SubagentNotification,
  ): Effect.Effect<SubagentNotificationDelivery | undefined> => {
    if (
      notification.type === "completed" &&
      notification.runs.every(
        (run) =>
          (records.get(run.id)?.view.parentRunId ?? SUBAGENT_ROOT_RUN_ID) === SUBAGENT_ROOT_RUN_ID,
      )
    )
      return Effect.succeed(notifyRoot(notification));
    if (notification.type === "question")
      return deliverToNearestAncestor(notification.id, ancestorMessage(notification)).pipe(
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
        deliverToNearestAncestor(run.id, ancestorMessage({ type: "completed", runs: [run] })).pipe(
          Effect.map((delivered) => {
            const key = completionNotificationKey(run.id, run.generation);
            if (delivered) return key;
            const runs = [run];
            const rootDelivery = notifyRoot({ type: "completed", runs });
            return deliveredCompletionKeys(rootDelivery, runs).has(key) ? key : undefined;
          }),
        ),
      { concurrency: 4 },
    ).pipe(
      Effect.map((keys) => ({
        deliveredCompletionKeys: keys.filter((key): key is string => key !== undefined),
      })),
    );
  };
}
