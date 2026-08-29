import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
  registerAdvisorAbortListenerEffect,
  type AdvisorSessionInput,
} from "../../../boundary/host-context.ts";
import { selectAdvisorOnboardingAtHostBoundary } from "../../../boundary/host-onboarding.ts";
import { summarizeAdvisorReview } from "../../../checkpoint/ledger.ts";
import { getAdvisorConfigPath } from "../../../config/options.ts";
import { loadAdvisorInstructionsEffect } from "../../../review/instructions.ts";
import { AdvisorExtensionError, extensionError } from "../../controller.ts";
import type { EventsDeps } from "./types.ts";

export const makeSessionLifecycle = (d: EventsDeps) => {
  const refs = d.refs;
  const sessionInitializeEffect = (input: AdvisorSessionInput) =>
    Effect.gen(function* () {
      const ctx = input.ctx;
      d.updateApplicationState((state) => ({
        ...state,
        epoch: state.epoch + 1,
        cancellationEpoch: state.cancellationEpoch + 1,
      }));
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
        d.cancelRequest();
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
        d.initializeSession(loadedConfig);
        refs.instructions = yield* loadAdvisorInstructionsEffect(
          d.currentConfig().configPath,
          input.cwd,
          input.projectTrusted,
        ).pipe(Effect.mapError(extensionError("instruction load")));
        refs.pendingExplicitStart = undefined;
        refs.lastCandidate = undefined;
        refs.checkpointId = 0;
        refs.latestStateSummary = "";
        refs.latestDurableSummary = summarizeAdvisorReview();
        if (hostCancellationPending)
          return yield* new AdvisorExtensionError({
            operation: "session initialization",
            message: "Advisor session initialization was cancelled.",
          });
        hostCancellationActive = true;
        yield* d.startRuntimeEffect(ctx, "restore-branch");
        refs.removeHostCancellation = registration.remove;
        registrationCommitted = true;
        if (
          d.currentConfig().enabled &&
          !d.currentConfig().configured &&
          !d.currentConfig().setupDismissed &&
          ctx.mode === "tui"
        ) {
          const onboardingConfigPath = d.currentConfig().configPath;
          const onboarding = selectAdvisorOnboardingAtHostBoundary(ctx).pipe(
            Effect.flatMap((selected) => {
              if (!selected) return Effect.void;
              const patch =
                selected.type === "model"
                  ? {
                      provider: selected.provider,
                      model: selected.model,
                      enabled: true,
                      setupDismissed: true,
                    }
                  : { setupDismissed: true };
              return d.persistCommandConfig(patch, onboardingConfigPath).pipe(
                Effect.catch(() =>
                  Effect.sync(() => {
                    d.notifyBestEffort(ctx, "Could not save Advisor setup.", "warning");
                  }),
                ),
                Effect.asVoid,
              );
            }),
            Effect.catch(() => Effect.void),
          );
          yield* Effect.forkIn(onboarding, d.applicationScope, { startImmediately: true });
        }
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
      d.resetSessionTreeDomain();
    }).pipe(Effect.andThen(d.startRuntimeEffect(ctx, "restore-branch")), Effect.asVoid);

  return { sessionInitializeEffect, sessionShutdownEffect, compactEffect, treeEffect };
};
