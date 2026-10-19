import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import { MAX_TARGET_RUNS } from "../run/limits.ts";
import {
  isTerminalRunState,
  isParentActionRequiredRun,
  type SubagentRunView,
} from "../run/model.ts";
import type { SubagentAwaitUntil } from "../run/service.ts";
import { projectRunCardTree } from "../ui/run-tree-rows.ts";
import { awaitDetails } from "./details.ts";
import { attentionRecoveryText, joinBoundedToolText } from "./format.ts";
import { formatAwaitProgress } from "./render-await.ts";
import { cancelledAwaitContract } from "./contract.ts";
import { encodeSubagentContract } from "./contract-schema.ts";

export const observeAwaitInterruption = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  onInterruption?: () => void,
): Effect.Effect<A, E, R> =>
  onInterruption
    ? Effect.uninterruptibleMask((restore) =>
        restore(effect).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) onInterruption();
            }),
          ),
        ),
      )
    : effect;

/** Why a wait ended before its targets finished; children keep running in every case. */
export type AwaitEnding =
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out"; readonly seconds: number }
  | { readonly kind: "user_input" };

export function awaitExecutionFor(
  ids: ReadonlyArray<string>,
  until: SubagentAwaitUntil,
  onUpdate?: AgentToolUpdateCallback<unknown>,
) {
  const requestedIds = [
    ...new Set(
      ids.flatMap((id) => {
        const trimmed = id.trim();
        return trimmed ? [trimmed] : [];
      }),
    ),
  ].slice(0, MAX_TARGET_RUNS);
  let latestRuns: ReadonlyArray<SubagentRunView> = [];
  let contextRuns: ReadonlyArray<SubagentRunView> = [];
  let lastUpdate = "";
  let interrupted = false;
  const deliveryAttemptedIds = new Set<string>();
  const progressText = (runs: ReadonlyArray<SubagentRunView>) =>
    formatAwaitProgress(
      runs,
      until,
      projectRunCardTree(contextRuns)
        .map((row) => row.run)
        .slice(0, Math.max(0, MAX_TARGET_RUNS - runs.length)),
    );
  const update = (
    runs: ReadonlyArray<SubagentRunView>,
    projection?: ReadonlyArray<SubagentRunView>,
  ) => {
    latestRuns = runs;
    const scope = projection ?? runs;
    const targetIds = new Set(runs.map((run) => run.id));
    const byId = new Map(scope.map((run) => [run.id, run]));
    contextRuns = scope.filter((run) => {
      if (targetIds.has(run.id)) return false;
      const visited = new Set<string>([run.id]);
      let parentRunId = run.parentRunId;
      while (parentRunId && !visited.has(parentRunId)) {
        visited.add(parentRunId);
        if (targetIds.has(parentRunId)) return true;
        parentRunId = byId.get(parentRunId)?.parentRunId;
      }
      return false;
    });
    const details = awaitDetails({
      runs,
      contextRuns,
      awaitedRunIds: requestedIds,
      awaitUntil: until,
    });
    const key = JSON.stringify(details);
    if (key === lastUpdate) return;
    lastUpdate = key;
    onUpdate?.({ content: [{ type: "text", text: progressText(runs) }], details });
  };
  const cancelled = (
    proxyCleanupUnconfirmed = false,
    ending: AwaitEnding = { kind: "cancelled" },
  ): AgentToolResult<unknown> => {
    const unfinished = latestRuns.filter((run) => !isTerminalRunState(run.state)).length;
    const timedOutSeconds = ending.kind === "timed_out" ? ending.seconds : undefined;
    const ended = Match.value(ending).pipe(
      Match.when({ kind: "timed_out" }, ({ seconds }) => `Await timed out after ${seconds}s`),
      Match.when(
        { kind: "user_input" },
        () => "Await ended because the user sent a message; read it before waiting again",
      ),
      Match.orElse(() => "Await cancelled"),
    );
    const summary =
      latestRuns.length === 0
        ? `${ended} before progress was observed; selected run states are unobserved.`
        : `${ended}; ${unfinished} subagent${unfinished === 1 ? " is" : "s are"} unfinished in the latest observation.`;
    const text = joinBoundedToolText([
      summary,
      `Requested runs: ${requestedIds.join(", ")}.`,
      "Only this local wait ended. Children continue; it did not stop or retry any run.",
      proxyCleanupUnconfirmed
        ? "Root completion-claim cleanup is unconfirmed. Claims may still be held; an immediate replacement await may fail with completion_claim_conflict. This receipt does not acknowledge root cleanup."
        : "Await these IDs again when their results are needed.",
      deliveryAttemptedIds.size > 0
        ? "Report delivery may have committed before cancellation. Read the latest retained reports with agent_read."
        : "",
      latestRuns.length > 0 ? progressText(latestRuns) : "",
      attentionRecoveryText(latestRuns),
    ]);
    return {
      content: [{ type: "text", text }],
      structuredContent: encodeSubagentContract(
        cancelledAwaitContract({
          runs: latestRuns,
          requestedRunIds: requestedIds,
          until,
          cleanup: proxyCleanupUnconfirmed ? "unconfirmed" : "confirmed",
          deliveryAttemptedIds,
          ending: ending.kind,
        }),
      ),
      details: awaitDetails({
        runs: latestRuns,
        contextRuns,
        awaitedRunIds: requestedIds,
        awaitUntil: until,
        cancelled: true,
        timedOutSeconds,
        ...(ending.kind === "user_input" && { endedByUserInput: true as const }),
        ...(proxyCleanupUnconfirmed && { cancellationCleanup: "unconfirmed" as const }),
        ...(latestRuns.some(isParentActionRequiredRun) && { attentionRequired: true }),
      }),
    };
  };
  return {
    requestedIds,
    progressText,
    update,
    contextRuns: () => contextRuns,
    markInterrupted: () => {
      interrupted = true;
    },
    wasInterrupted: () => interrupted,
    markDeliveryAttempt: (attempted: ReadonlyArray<string>) => {
      for (const id of attempted) deliveryAttemptedIds.add(id);
    },
    cancelled,
  };
}

export type AwaitExecution = ReturnType<typeof awaitExecutionFor>;
