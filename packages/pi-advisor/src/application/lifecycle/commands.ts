import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../boundary/executor.ts";
import type { PiCommandAdapter } from "../../boundary/host-commands.ts";
import {
  appendAdvisorReviewActionAtHostBoundary,
  latestOpenAdvisorReviewCardAtHostBoundary,
  sendCompactAdvisorGuidanceAtHostBoundary,
} from "../../boundary/host-review-cards.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import type { CheckpointOrchestratorShape } from "../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import type { AdvisorCommandActions } from "../../settings/controller.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { EventsDeps } from "./events/types.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface CommandWorkflowDeps {
  readonly pi: ExtensionAPI;
  readonly refs: SessionRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly clearPendingRecovery: () => void;
  readonly clearPendingReceipt: () => void;
  readonly latchCancellation: () => void;
  readonly resetRequestDomain: (resetLifecycle?: boolean) => void;
  readonly advanceDomainCounter: EventsDeps["advanceDomainCounter"];
  readonly persistCurrentLedger: (ctx: ExtensionContext) => void;
  readonly checkpointOrchestrator: CheckpointOrchestratorShape;
  readonly startRuntimeEffect: EventsDeps["startRuntimeEffect"];
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
  ) => Promise<A>;
  readonly runWithExplicitRuntimeEffect: EventsDeps["runWithExplicitRuntimeEffect"];
  readonly requestCheckpoint: EventsDeps["requestCheckpoint"];
  readonly parentExecutor: AdvisorEffectExecutor;
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
        Boolean(d.refs.queue && d.refs.queue.pendingCheckpoints > 0);
      if (!hadWork) return Effect.succeed(false);
      d.refs.pendingExplicitStart = undefined;
      d.clearPendingRecovery();
      d.clearPendingReceipt();
      d.latchCancellation();
      d.advanceDomainCounter("cancellationEpoch");
      d.persistCurrentLedger(ctx);
      return d.checkpointOrchestrator
        .cancelAll()
        .pipe(Effect.andThen(d.startRuntimeEffect(ctx)), Effect.as(true));
    });

  const commandActions: AdvisorCommandActions = {
    cancel: (ctx) => d.runSessionEffect(cancelEffect(ctx)),
    fixLast: (ctx) => {
      const card = latestOpenAdvisorReviewCardAtHostBoundary(ctx);
      if (!card) return "unavailable";
      if (!sendCompactAdvisorGuidanceAtHostBoundary(d.pi, card, true)) return "delivery-failed";
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
      if (!candidate) return d.runSessionEffect(Effect.succeed("unavailable" as const));
      return d.runSessionEffect(
        d
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
          .pipe(Effect.map((handle) => (handle ? ("started" as const) : ("cancelled" as const)))),
      );
    },
  };

  const applyCommittedConfigEffect = (next: ResolvedAdvisorConfig): Effect.Effect<void> =>
    Effect.sync(() => {
      const disabling = d.currentConfig().enabled && !next.enabled;
      d.updateApplicationState((state) => ({
        ...state,
        config: next,
      }));
      d.refs.configRevision += 1;
      d.clearPendingRecovery();
      d.resetRequestDomain(true);
      d.refs.latestStateSummary = "";
      d.refs.latestDurableSummary = summarizeAdvisorReview();
      d.refs.pendingExplicitStart = undefined;
      if (disabling) d.latchCancellation();
      d.advanceDomainCounter("cancellationEpoch");
      const ctx = d.refs.activeContext;
      if (!ctx) return;
      d.persistCurrentLedger(ctx);
      try {
        d.parentExecutor.fork(d.startRuntimeEffect(ctx));
      } catch {
        // Slot deactivation already owns runtime cleanup; the next session reloads disk state.
      }
    });

  return { cancelEffect, commandActions, applyCommittedConfigEffect };
};
