import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../boundary/executor.ts";
import type { PiCommandAdapter } from "../../boundary/host-commands.ts";
import { summarizeAdvisorReview } from "../../checkpoint/ledger.ts";
import type { CheckpointOrchestratorShape } from "../../checkpoint/orchestrator.ts";
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import type { AdvisorCommandActions } from "../../settings/controller.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { EventsDeps } from "./events/types.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface CommandWorkflowDeps {
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
  readonly stopRuntimeEffect: () => Effect.Effect<void>;
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
  ) => Promise<A>;
  readonly setAdvisorStatus: (ctx: ExtensionContext, text?: string) => void;
  readonly publishControllerSnapshotNow: () => void;
  readonly startRuntime: (
    ctx: ExtensionContext,
    restoration?: "preserve-live" | "restore-branch",
    allowDisabled?: boolean,
  ) => Promise<number | undefined>;
  readonly runWithExplicitRuntimeEffect: EventsDeps["runWithExplicitRuntimeEffect"];
  readonly requestCheckpoint: EventsDeps["requestCheckpoint"];
  readonly parentExecutor: AdvisorEffectExecutor;
}

export const makeCommandWorkflows = (d: CommandWorkflowDeps) => {
  const cancelEffect = (
    ctx: Parameters<AdvisorCommandActions["cancel"]>[0],
  ): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      const hadRequestedReview = d.getState().reviewNext;
      const hadExplicitStart = d.refs.pendingExplicitStart !== undefined;
      const hadRecovery = Boolean(d.getState().pendingPersistentRecovery);
      d.updateApplicationState((state) => ({ ...state, reviewNext: false }));
      d.refs.pendingExplicitStart = undefined;
      d.clearPendingRecovery();
      d.clearPendingReceipt();
      d.latchCancellation();
      d.advanceDomainCounter("cancellationEpoch");
      d.persistCurrentLedger(ctx);
      const hadWork =
        hadRequestedReview ||
        hadExplicitStart ||
        hadRecovery ||
        Boolean(
          d.refs.queue &&
          (d.refs.queue.pendingCheckpoints > 0 ||
            d.refs.queue.backlog > 0 ||
            d.refs.queue.processedThrough < d.refs.queue.sequence),
        );
      return d.checkpointOrchestrator
        .cancelAll()
        .pipe(Effect.andThen(d.startRuntimeEffect(ctx)), Effect.as(hadWork));
    });

  const commandActions: AdvisorCommandActions = {
    cancel: (ctx) => d.runSessionEffect(cancelEffect(ctx)),
    pause: (ctx) => {
      d.updateApplicationState((state) => ({ ...state, paused: true, reviewNext: false }));
      d.refs.pendingExplicitStart = undefined;
      d.clearPendingRecovery();
      d.clearPendingReceipt();
      d.latchCancellation();
      d.advanceDomainCounter("cancellationEpoch");
      d.persistCurrentLedger(ctx);
      d.advanceDomainCounter("epoch");
      void d.runSessionEffect(
        d.checkpointOrchestrator.cancelAll().pipe(Effect.andThen(d.stopRuntimeEffect())),
      );
      d.setAdvisorStatus(ctx, "advisor: paused");
      d.publishControllerSnapshotNow();
    },
    resume: (ctx) => {
      d.updateApplicationState((state) => ({ ...state, paused: false }));
      d.publishControllerSnapshotNow();
      void d.startRuntime(ctx);
    },
    reviewLast: (ctx, focus) => {
      const candidate = d.refs.lastCandidate;
      if (!candidate) return d.runSessionEffect(Effect.succeed("unavailable" as const));
      return d.runSessionEffect(
        d
          .runWithExplicitRuntimeEffect(ctx, () => {
            if (d.refs.lastCandidate !== candidate) return undefined;
            return d.requestCheckpoint({
              ctx,
              focus,
              phase: "final",
              source: focus === "verification" ? "verify" : "last",
              requiresEnabled: false,
            });
          })
          .pipe(Effect.map((handle) => (handle ? ("started" as const) : ("cancelled" as const)))),
      );
    },
    reviewNext: () => {
      d.updateApplicationState((state) => ({ ...state, reviewNext: true }));
    },
  };

  const applyCommittedConfigEffect = (next: ResolvedAdvisorConfig): Effect.Effect<void> =>
    Effect.sync(() => {
      const enabledChanged = d.currentConfig().enabled !== next.enabled;
      const disabling = d.currentConfig().enabled && !next.enabled;
      d.updateApplicationState((state) => ({
        ...state,
        config: next,
        paused: enabledChanged ? false : state.paused,
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
