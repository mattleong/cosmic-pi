import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import {
  appendAdvisorReviewActionAtHostBoundary,
  latestOpenAdvisorReviewCardAtHostBoundary,
  sendCompactAdvisorGuidanceAtHostBoundary,
} from "../../boundary/host-review-cards.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import type { CheckpointOrchestratorContract } from "../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import type { AdvisorCommandActions } from "../../settings/controller.ts";
import { incrementBounded } from "../controller-helpers.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { EventsDeps } from "./events/types.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface CommandWorkflowDeps {
  readonly pi: ExtensionAPI;
  readonly refs: SessionRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly updateMetrics: (
    update: (metrics: AdvisorApplicationState["metrics"]) => AdvisorApplicationState["metrics"],
  ) => void;
  readonly cancelRequest: () => void;
  readonly commitConfig: (config: ResolvedAdvisorConfig) => void;
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly applicationScope: Scope.Scope;
  readonly checkpointOrchestrator: CheckpointOrchestratorContract;
  readonly startRuntimeEffect: EventsDeps["startRuntimeEffect"];
  readonly runWithExplicitRuntimeEffect: EventsDeps["runWithExplicitRuntimeEffect"];
  readonly requestCheckpoint: EventsDeps["requestCheckpoint"];
}

export const makeCommandWorkflows = (d: CommandWorkflowDeps) => {
  const cancelEffect = (
    ctx: Parameters<AdvisorCommandActions["cancel"]>[0],
  ): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const hadExplicitStart = d.refs.pendingExplicitStart !== undefined;
      const hadRecovery = Boolean(d.getState().pendingPersistentRecovery);
      const hadWork =
        hadExplicitStart ||
        hadRecovery ||
        d.checkpointOrchestrator.activeCount() > 0 ||
        Boolean(d.refs.queue && d.refs.queue.pendingCheckpoints > 0);
      if (!hadWork) return Effect.succeed(false);
      d.refs.pendingExplicitStart = undefined;
      d.cancelRequest();
      d.persistCurrentLedger(ctx);
      return d.checkpointOrchestrator
        .cancelAll()
        .pipe(Effect.andThen(d.startRuntimeEffect(ctx)), Effect.as(true));
    });

  const commandActions: AdvisorCommandActions = {
    cancel: cancelEffect,
    fixLast: (ctx) => {
      const card = latestOpenAdvisorReviewCardAtHostBoundary(ctx);
      if (!card) return "unavailable";
      if (!sendCompactAdvisorGuidanceAtHostBoundary(d.pi, card, true)) return "delivery-failed";
      d.updateMetrics((metrics) => ({
        ...metrics,
        corrections: incrementBounded(metrics.corrections),
      }));
      return appendAdvisorReviewActionAtHostBoundary(d.pi, card, "fix")
        ? "applied"
        : "state-failed";
    },
    dismissLast: (ctx) => {
      const card = latestOpenAdvisorReviewCardAtHostBoundary(ctx);
      if (!card) return "unavailable";
      return appendAdvisorReviewActionAtHostBoundary(d.pi, card, "dismiss")
        ? "applied"
        : "state-failed";
    },
    reviewLast: (ctx) => {
      const candidate = d.refs.lastCandidate;
      if (!candidate) return Effect.succeed("unavailable" as const);
      return d
        .runWithExplicitRuntimeEffect(ctx, () => {
          if (d.refs.lastCandidate !== candidate) return undefined;
          return d.requestCheckpoint({
            ctx,
            focus: "standard",
            phase: "final",
            source: "last",
            requiresEnabled: false,
          });
        })
        .pipe(Effect.map((handle) => (handle ? ("started" as const) : ("cancelled" as const))));
    },
  };

  const applyCommittedConfigEffect = (next: ResolvedAdvisorConfig): Effect.Effect<void> =>
    Effect.sync(() => {
      d.commitConfig(next);
      d.refs.latestStateSummary = "";
      d.refs.latestDurableSummary = summarizeAdvisorReview();
      d.refs.pendingExplicitStart = undefined;
      const ctx = d.refs.activeContext;
      if (ctx) d.persistCurrentLedger(ctx);
      return ctx;
    }).pipe(
      Effect.flatMap((ctx) =>
        ctx
          ? Effect.forkIn(d.startRuntimeEffect(ctx), d.applicationScope, {
              startImmediately: true,
            }).pipe(Effect.asVoid)
          : Effect.void,
      ),
    );

  return { commandActions, applyCommittedConfigEffect };
};
