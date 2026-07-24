import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  registerAdvisorAbortListenerEffect,
  type AdvisorSessionInput,
} from "../../../boundary/host-context.ts";
import { summarizeAdvisorReview } from "../../../checkpoint/ledger.ts";
import { getAdvisorConfigPath } from "../../../config/options.ts";
import { loadAdvisorInstructionsEffect } from "../../../review/instructions.ts";
import { emptyAdvisorRoutingState } from "../../../review/routing.ts";
import { warnIfSetupRequired } from "../../controller-helpers.ts";
import { AdvisorExtensionError, extensionError } from "../../controller-types.ts";
import { initialAdvisorApplicationState } from "../../state.ts";
import type { EventsDeps } from "./types.ts";

export const makeSessionLifecycle = (d: EventsDeps) => {
  const refs = d.refs;
  const sessionInitializeEffect = (input: AdvisorSessionInput) =>
    Effect.gen(function* () {
      const ctx = input.ctx;
      d.advanceDomainCounter("epoch");
      d.advanceDomainCounter("cancellationEpoch");
      refs.pendingExplicitStart = undefined;
      yield* d.checkpointOrchestrator.cancelAll();
      refs.removeHostCancellation?.();
      refs.removeHostCancellation = undefined;
      refs.activeContext = undefined;
      refs.activeSessionInput = undefined;
      yield* d.stopRuntimeUnlockedEffect();
      let hostCancellationPending = false;
      let hostCancellationActive = false;
      const applyHostCancellation = () => {
        d.latchCancellation();
        d.clearPendingRecovery();
        d.clearPendingReceipt();
        d.advanceDomainCounter("cancellationEpoch");
        d.persistCurrentLedger(ctx);
      };
      const latchHostCancellation = () => {
        hostCancellationPending = true;
        if (hostCancellationActive) applyHostCancellation();
      };
      const registration = yield* registerAdvisorAbortListenerEffect(
        input,
        latchHostCancellation,
      ).pipe(Effect.mapError(extensionError("host cancellation registration")));
      let registrationCommitted = false;
      const initialize = Effect.gen(function* () {
        refs.activeContext = ctx;
        refs.activeSessionInput = input;
        const configPath = d.currentConfig().configPath || getAdvisorConfigPath();
        const loadedConfig = yield* d.configStore
          .load(configPath)
          .pipe(Effect.mapError(extensionError("config load")));
        refs.configRevision += 1;
        d.updateApplicationState(() => initialAdvisorApplicationState(loadedConfig));
        refs.childStartedOnce = false;
        refs.instructions = yield* loadAdvisorInstructionsEffect(
          d.currentConfig().configPath,
          input.cwd,
          input.projectTrusted,
        ).pipe(Effect.mapError(extensionError("instruction load")));
        d.updateApplicationState((state) => ({
          ...state,
          paused: false,
          reviewNext: false,
          guidancePaths: [...refs.instructions.paths],
          hasLastCandidate: false,
        }));
        refs.pendingExplicitStart = undefined;
        refs.lastCandidate = undefined;
        d.setDomainCounter("parentTurnId", 0);
        refs.checkpointId = 0;
        d.advanceDomainCounter("cancellationEpoch");
        d.resetRequestDomain(true);
        d.setDomainCounter("requestSequence", 0);
        d.updateApplicationState((state) => ({
          ...state,
          routing: emptyAdvisorRoutingState(),
        }));
        refs.latestStateSummary = "";
        refs.latestDurableSummary = summarizeAdvisorReview();
        d.updateApplicationState((state) => ({
          ...state,
          reportedFailures: [],
          reportedDiagnostics: [],
        }));
        yield* d.publishControllerSnapshot();
        if (!d.currentConfig().configured)
          warnIfSetupRequired(ctx, d.currentConfig(), () => undefined, d.notifyBestEffort);
        if (hostCancellationPending)
          return yield* new AdvisorExtensionError({
            operation: "session initialization",
            message: "Advisor session initialization was cancelled.",
          });
        hostCancellationActive = true;
        yield* d.startRuntimeEffect(ctx, "restore-branch");
        refs.removeHostCancellation = registration.remove;
        registrationCommitted = true;
      });
      yield* initialize.pipe(
        Effect.onExit(() =>
          registrationCommitted
            ? Effect.void
            : Effect.sync(() => {
                registration.remove();
                if (refs.activeContext === ctx) refs.activeContext = undefined;
                if (refs.activeSessionInput === input) refs.activeSessionInput = undefined;
              }),
        ),
      );
    });

  const sessionShutdownEffect = () =>
    Effect.sync(() => {
      d.advanceDomainCounter("epoch");
      refs.pendingExplicitStart = undefined;
      refs.activeContext = undefined;
      refs.activeSessionInput = undefined;
      refs.removeHostCancellation?.();
      refs.removeHostCancellation = undefined;
    }).pipe(
      Effect.andThen(d.checkpointOrchestrator.cancelAll()),
      Effect.andThen(d.stopRuntimeEffect()),
    );

  const compactEffect = (ctx: ExtensionContext) =>
    Effect.sync(() => {
      d.ingest({ type: "compaction", marker: "Parent context was compacted." });
      refs.pendingExplicitStart = undefined;
    }).pipe(Effect.andThen(d.startRuntimeEffect(ctx)), Effect.asVoid);

  const treeEffect = (ctx: ExtensionContext) =>
    Effect.sync(() => {
      d.ingest({ type: "tree", marker: "Parent active branch changed." });
      refs.pendingExplicitStart = undefined;
      refs.lastCandidate = undefined;
      d.updateApplicationState((state) => ({ ...state, hasLastCandidate: false }));
      d.resetRequestDomain(true);
    }).pipe(Effect.andThen(d.startRuntimeEffect(ctx, "restore-branch")), Effect.asVoid);

  return { sessionInitializeEffect, sessionShutdownEffect, compactEffect, treeEffect };
};
