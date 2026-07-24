// The Context key intentionally retains its pre-move public identity.
// @effect-diagnostics effect/deterministicKeys:off
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { advisorNow } from "../../boundary/clock.ts";
import { type AdvisorEffectExecutor, type AdvisorPlatform } from "../../boundary/executor.ts";
import type { AdvisorHostCommandDefinition } from "../../boundary/host-bindings.ts";
import { PiCommandAdapter } from "../../boundary/host-commands.ts";
import { HostNotifier } from "../../boundary/host-notifier.ts";
import {
  ADVISOR_CHECKPOINT_ENTRY_TYPE,
  createCheckpointLedger,
  createLedgerFingerprint,
  summarizeAdvisorReview,
} from "../../checkpoint/ledger.ts";
import { makeCheckpointOrchestrator } from "../../checkpoint/orchestrator.ts";
import { normalizeAdvisorConfig, type ResolvedAdvisorConfig } from "../../config/options.ts";
import { ConfigStore } from "../../config/store.ts";
import { FailureLogger } from "../../logging/logger.ts";
import { AdvisorReviewQueue, AdvisorReviewQueueService } from "../../queue/service.ts";
import { rollbackAdvisorFindingDedupe } from "../../review/dedupe.ts";
import { buildAdvisorContext } from "../../review/context.ts";
import {
  exportAdvisorEmissionRecords,
  rollbackAdvisorEmission,
} from "../../review/emission-guard.ts";
import { sanitizeInterventionBudgetSnapshot } from "../../review/intervention-budget.ts";
import { AdvisorRuntimeService } from "../../runtime/runtime.ts";
import { makeAdvisorResourceState } from "../../runtime/resource-state.ts";
import { type AdvisorCommandActions, registerAdvisorCommands } from "../../settings/controller.ts";
import { makeAdvisorStatusService } from "../../status/service.ts";
import { makeAdvisorProjection, type AdvisorControllerSnapshot } from "../../ui/projection.ts";
import { activeContextMessages, incrementBounded } from "../controller-helpers.ts";
import {
  ADVISOR_CATCH_UP_TIMEOUT_MS,
  AdvisorController,
  AdvisorExtensionError,
  extensionError,
  type AdvisorControllerApplicationOptions,
  type AdvisorSkipReason,
  type ParentAnchor,
  UNREADABLE_PARENT_ANCHOR,
} from "../controller-types.ts";
import {
  emptyAdvisorSessionMetrics,
  initialAdvisorApplicationState,
  makeAdvisorApplicationStateStore,
} from "../state.ts";
import { makeLifecycleApplicationState } from "./application-state.ts";
import { makeCheckpointControls } from "./checkpoint.ts";
import { makeDeliver } from "./delivery.ts";
import { registerLifecycleEvents } from "./events.ts";
import { branchContainsAnchor, readLifecycleScope, readParentAnchor } from "./parent-session.ts";
import { cloneSessionMetrics, recordReviewDurationMetrics, recordUsageMetrics } from "./metrics.ts";
import { makeRuntimeControls } from "./runtime.ts";
import { createSessionRefs } from "./session-refs.ts";
import { makeLifecycleStatusControls } from "./status.ts";

export const advisorControllerApplicationLayer = (options: AdvisorControllerApplicationOptions) =>
  Layer.effect(
    AdvisorController,
    Effect.gen(function* () {
      const { pi, dependencies } = options;
      const createRuntime = dependencies.createRuntime;
      const catchUpTimeoutMs = Math.min(
        ADVISOR_CATCH_UP_TIMEOUT_MS,
        Math.max(1, dependencies.catchUpTimeoutMs ?? ADVISOR_CATCH_UP_TIMEOUT_MS),
      );
      const productionRuntimeService = yield* AdvisorRuntimeService;
      const productionQueueService = yield* AdvisorReviewQueueService;
      const commandAdapter = yield* PiCommandAdapter;
      const configStore = yield* ConfigStore;
      const failureLogger = yield* FailureLogger;
      const hostNotifier = yield* HostNotifier;
      const applicationScope = yield* Effect.scope;
      const platformContext = yield* Effect.context<AdvisorPlatform>();
      const resources = yield* makeAdvisorResourceState();
      const checkpointOrchestrator = yield* makeCheckpointOrchestrator(options.executor);
      const statusService = yield* makeAdvisorStatusService(options.executor);
      const projection = yield* makeAdvisorProjection({
        config: normalizeAdvisorConfig({}, ""),
        metrics: emptyAdvisorSessionMetrics(),
        paused: false,
        started: false,
      });
      const productionController = {
        publish: (next: AdvisorControllerSnapshot) => projection.replace(next).pipe(Effect.orDie),
        publishNow: projection.replaceNow,
        replaceChild: resources.replaceChild,
        stopChild: () => resources.stopChild,
      };
      const hostBindings = options.hostBindings;
      const commandRegistrar = {
        registerCommand: (name: string, definition: AdvisorHostCommandDefinition) =>
          hostBindings.registerCommand(name, definition),
      };
      const parentExecutor: AdvisorEffectExecutor = options.executor;
      const refs = createSessionRefs();
      const applicationStateStore = makeAdvisorApplicationStateStore(
        initialAdvisorApplicationState(normalizeAdvisorConfig({}, "")),
      );

      const {
        publishControllerSnapshotNow,
        publishControllerSnapshot,
        updateApplicationState,
        mutateMetrics,
        currentConfig,
        isPaused,
        isStarted,
        mutateTrajectory,
        setDomainCounter,
        advanceDomainCounter,
        recordReceipt,
        clearPendingReceipt,
        latchCancellation,
        resetRequestDomain,
      } = makeLifecycleApplicationState({
        store: applicationStateStore,
        refs,
        publish: productionController.publish,
        publishNow: productionController.publishNow,
      });
      const runSessionEffect = <A, E>(
        effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
      ): Promise<A> =>
        parentExecutor.run(effect.pipe(Effect.provideService(PiCommandAdapter, commandAdapter)));

      const notifyBestEffort = hostNotifier.notify;

      const { stopStatusSpinner, setAdvisorStatus, startStatusSpinner, settleStatusSpinner } =
        makeLifecycleStatusControls({
          statusService,
          currentConfig,
          isPaused,
          updateApplicationState,
        });

      const recordSkip = (reason: AdvisorSkipReason): void => {
        mutateMetrics((next) => {
          const skipped = next.skippedReviews ?? {};
          next.skippedReviews = { ...skipped, [reason]: incrementBounded(skipped[reason]) };
        });
      };

      const recordUsage = recordUsageMetrics;
      const recordReviewDuration = (
        target: Parameters<typeof recordReviewDurationMetrics>[0],
        startedAt: number,
      ) => recordReviewDurationMetrics(target, startedAt, advisorNow(parentExecutor));

      const seedFromMessages = (messages: readonly unknown[]): string =>
        buildAdvisorContext({
          messages,
          candidate: refs.lastCandidate?.candidate ?? "[No completed candidate at this cursor.]",
          maxChars: currentConfig().maxContextChars,
        }).transcript;
      const activeSeed = (ctx: ExtensionContext): string =>
        seedFromMessages(activeContextMessages(ctx));

      const fingerprint = (): string =>
        createLedgerFingerprint({
          provider: currentConfig().provider ?? "",
          model: currentConfig().model ?? "",
          cwd: refs.activeSessionInput?.cwd ?? "",
          guidance: refs.instructions.content ?? "",
          fastMode: currentConfig().fastMode,
          thinkingLevel: currentConfig().thinkingLevel,
        });

      const parentAnchor = readParentAnchor;
      const lifecycleScope = readLifecycleScope;
      const branchContains = branchContainsAnchor;

      const clearPersistentTrajectory = (): void => {
        refs.activeTrajectoryResource?.cancelTimer?.();
        refs.activeTrajectoryResource = undefined;
        refs.activeToolCalls.clear();
        updateApplicationState((state) => ({ ...state, activeTrajectory: undefined }));
      };

      const clearPendingRecovery = (): void => {
        updateApplicationState((state) => {
          const pending = state.pendingPersistentRecovery;
          if (pending) {
            const nextMetrics = cloneSessionMetrics(state.metrics);
            nextMetrics.outcomes.suppressed += 1;
            return {
              ...state,
              metrics: nextMetrics,
              pendingPersistentRecovery: undefined,
              abortInProgress: undefined,
              emissionGuard: rollbackAdvisorEmission(
                state.emissionGuard,
                pending.emission.rollback,
              ),
              findingDedupe: rollbackAdvisorFindingDedupe(
                state.findingDedupe,
                pending.dedupeRollback,
              ),
              interventionBudget: sanitizeInterventionBudgetSnapshot({
                ...pending.budgetBefore,
                correctionUsed: true,
              }),
            };
          }
          return {
            ...state,
            pendingPersistentRecovery: undefined,
            abortInProgress: undefined,
          };
        });
      };

      const {
        stopRuntimeUnlockedEffect,
        stopRuntimeEffect,
        stopRuntime,
        startRuntimeEffect,
        startRuntime,
        runWithExplicitRuntimeEffect,
      } = makeRuntimeControls({
        refs,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        mutateMetrics,
        currentConfig,
        isPaused,
        isStarted,
        advanceDomainCounter,
        clearPersistentTrajectory,
        clearPendingRecovery,
        stopStatusSpinner,
        setAdvisorStatus,
        publishControllerSnapshot,
        publishControllerSnapshotNow,
        startStatusSpinner,
        settleStatusSpinner,
        runSessionEffect,
        parentExecutor,
        productionController,
        productionRuntimeService,
        productionQueueService,
        createRuntime,
        notifyBestEffort,
        seedFromMessages,
        activeSeed,
        fingerprint,
        parentAnchor,
        recordUsage,
      });

      const persistLedger = (anchor: ParentAnchor): void => {
        if (!anchor || anchor === UNREADABLE_PARENT_ANCHOR || typeof pi.appendEntry !== "function")
          return;
        const state = applicationStateStore.get();
        const pending = state.pendingPersistentRecovery;
        try {
          pi.appendEntry(
            ADVISOR_CHECKPOINT_ENTRY_TYPE,
            createCheckpointLedger({
              fingerprint: fingerprint(),
              anchorId: anchor,
              reviewSummary: refs.latestDurableSummary,
              cancellationLatched: state.routing.cancellationLatched,
              completedPrimaryTurns: state.routing.completedPrimaryTurns,
              immunityUntilCompletedTurn: state.routing.immunityUntilCompletedTurn,
              interventionBudget: pending
                ? {
                    ...pending.budgetBefore,
                    correctionUsed: true,
                  }
                : state.interventionBudget,
              findingLifecycle: state.findingLifecycle.records,
              emissionHashes: exportAdvisorEmissionRecords(state.emissionGuard).filter(
                (record) => !pending || !record.endsWith(`:${pending.emission.hash}`),
              ),
            }),
          );
        } catch {
          // Parent persistence is fail-open and cannot own runtime cleanup.
        }
      };

      const persistCurrentLedger = (ctx: ExtensionContext): void => {
        persistLedger(parentAnchor(ctx));
      };

      const ingest = (input: Parameters<AdvisorReviewQueue["ingest"]>[1]): void => {
        try {
          refs.queue?.ingest(applicationStateStore.get().parentTurnId, input);
        } catch {
          // Parent streaming and tool events always remain fail-open.
        }
      };

      const deliver = makeDeliver({
        pi,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        mutateMetrics,
        currentConfig,
        ingest,
        recordReceipt,
        notifyBestEffort,
        getConfigRevision: () => refs.configRevision,
      });

      const { requestCheckpoint, awaitCatchUpEffectOwned, awaitCatchUp } = makeCheckpointControls({
        refs,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        mutateMetrics,
        currentConfig,
        isPaused,
        isStarted,
        advanceDomainCounter,
        latchCancellation,
        clearPendingRecovery,
        clearPendingReceipt,
        persistCurrentLedger,
        persistLedger,
        notifyBestEffort,
        failureLogger,
        applicationScope,
        checkpointOrchestrator,
        parentExecutor,
        runSessionEffect,
        startRuntimeEffect,
        stopRuntime,
        deliver,
        fingerprint,
        parentAnchor,
        lifecycleScope,
        branchContains,
        recordReviewDuration,
        catchUpTimeoutMs,
      });

      const cancelEffect = (
        ctx: Parameters<AdvisorCommandActions["cancel"]>[0],
      ): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const hadRequestedReview = applicationStateStore.get().reviewNext;
          const hadExplicitStart = refs.pendingExplicitStart !== undefined;
          const hadRecovery = Boolean(applicationStateStore.get().pendingPersistentRecovery);
          updateApplicationState((state) => ({ ...state, reviewNext: false }));
          refs.pendingExplicitStart = undefined;
          clearPendingRecovery();
          clearPendingReceipt();
          latchCancellation();
          advanceDomainCounter("cancellationEpoch");
          persistCurrentLedger(ctx);
          const hadWork =
            hadRequestedReview ||
            hadExplicitStart ||
            hadRecovery ||
            Boolean(
              refs.queue &&
              (refs.queue.pendingCheckpoints > 0 ||
                refs.queue.backlog > 0 ||
                refs.queue.processedThrough < refs.queue.sequence),
            );
          return checkpointOrchestrator
            .cancelAll()
            .pipe(Effect.andThen(startRuntimeEffect(ctx)), Effect.as(hadWork));
        });

      const commandActions: AdvisorCommandActions = {
        cancel: (ctx) => runSessionEffect(cancelEffect(ctx)),
        pause: (ctx) => {
          updateApplicationState((state) => ({ ...state, paused: true, reviewNext: false }));
          refs.pendingExplicitStart = undefined;
          clearPendingRecovery();
          clearPendingReceipt();
          latchCancellation();
          advanceDomainCounter("cancellationEpoch");
          persistCurrentLedger(ctx);
          advanceDomainCounter("epoch");
          void runSessionEffect(
            checkpointOrchestrator.cancelAll().pipe(Effect.andThen(stopRuntimeEffect())),
          );
          setAdvisorStatus(ctx, "advisor: paused");
          publishControllerSnapshotNow();
        },
        resume: (ctx) => {
          updateApplicationState((state) => ({ ...state, paused: false }));
          publishControllerSnapshotNow();
          void startRuntime(ctx);
        },
        reviewLast: (ctx, focus) => {
          const candidate = refs.lastCandidate;
          if (!candidate) return runSessionEffect(Effect.succeed("unavailable" as const));
          return runSessionEffect(
            runWithExplicitRuntimeEffect(ctx, () => {
              if (refs.lastCandidate !== candidate) return undefined;
              return requestCheckpoint({
                ctx,
                focus,
                phase: "final",
                source: focus === "verification" ? "verify" : "last",
                requiresEnabled: false,
              });
            }).pipe(
              Effect.map((handle) => (handle ? ("started" as const) : ("cancelled" as const))),
            ),
          );
        },
        reviewNext: () => {
          updateApplicationState((state) => ({ ...state, reviewNext: true }));
        },
      };

      const applyCommittedConfigEffect = (next: ResolvedAdvisorConfig): Effect.Effect<void> =>
        Effect.sync(() => {
          const enabledChanged = currentConfig().enabled !== next.enabled;
          const disabling = currentConfig().enabled && !next.enabled;
          updateApplicationState((state) => ({
            ...state,
            config: next,
            paused: enabledChanged ? false : state.paused,
          }));
          refs.configRevision += 1;
          clearPendingRecovery();
          resetRequestDomain(true);
          refs.latestStateSummary = "";
          refs.latestDurableSummary = summarizeAdvisorReview();
          refs.pendingExplicitStart = undefined;
          if (disabling) latchCancellation();
          advanceDomainCounter("cancellationEpoch");
          const ctx = refs.activeContext;
          if (!ctx) return;
          persistCurrentLedger(ctx);
          try {
            parentExecutor.fork(startRuntimeEffect(ctx));
          } catch {
            // Slot deactivation already owns runtime cleanup; the next session reloads disk state.
          }
        });

      registerAdvisorCommands(
        commandRegistrar,
        {
          get: () => projection.getSnapshot().config,
          getMetrics: () => projection.getSnapshot().metrics,
          persist: (patch, path) =>
            parentExecutor.run(configStore.patch(patch, path, applyCommittedConfigEffect)),
          update: (next) => runSessionEffect(applyCommittedConfigEffect(next)),
        },
        commandActions,
        (effect) => runSessionEffect(effect),
      );

      const { sessionInitializeEffect, sessionShutdownEffect, compactEffect, treeEffect } =
        registerLifecycleEvents({
          refs,
          pi,
          hostBindings,
          getState: () => applicationStateStore.get(),
          updateApplicationState,
          mutateMetrics,
          currentConfig,
          isPaused,
          isStarted,
          advanceDomainCounter,
          setDomainCounter,
          clearPersistentTrajectory,
          clearPendingRecovery,
          clearPendingReceipt,
          latchCancellation,
          resetRequestDomain,
          persistCurrentLedger,
          persistLedger,
          ingest,
          recordReceipt,
          recordSkip,
          mutateTrajectory,
          runSessionEffect,
          parentExecutor,
          notifyBestEffort,
          startRuntimeEffect,
          stopRuntimeEffect,
          stopRuntimeUnlockedEffect,
          runWithExplicitRuntimeEffect,
          requestCheckpoint,
          awaitCatchUpEffectOwned,
          awaitCatchUp,
          fingerprint,
          parentAnchor,
          publishControllerSnapshot,
          checkpointOrchestrator,
          configStore,
        });

      const invokeEvent = (
        name: string,
        event: never,
        ctx: ExtensionContext,
      ): Effect.Effect<unknown, AdvisorExtensionError> =>
        Effect.suspend(() => {
          const handler = hostBindings.eventHandler(name);
          if (!handler) return Effect.void;
          return Effect.tryPromise({
            try: () => Promise.resolve(handler(event, ctx)),
            catch: extensionError(name),
          }).pipe(Effect.ensuring(publishControllerSnapshot()));
        });
      const invokeCommand = (
        name: string,
        args: string,
        ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
      ): Effect.Effect<unknown, AdvisorExtensionError> =>
        Effect.suspend(() => {
          const handler = hostBindings.commandHandler(name);
          if (!handler) return Effect.void;
          return publishControllerSnapshot().pipe(
            Effect.andThen(commandAdapter.fromPromise(() => Promise.resolve(handler(args, ctx)))),
            Effect.mapError(extensionError(`command ${name}`)),
            Effect.ensuring(publishControllerSnapshot()),
          );
        });
      const service = AdvisorController.of({
        getSnapshot: projection.getSnapshot,
        publish: productionController.publish,
        refreshProjection: Effect.suspend(publishControllerSnapshot),
        replaceChild: productionController.replaceChild,
        stopChild: productionController.stopChild,
        sessionInitialize: (_event, input) =>
          sessionInitializeEffect(input).pipe(Effect.provide(platformContext)),
        sessionShutdown: () => sessionShutdownEffect(),
        event: invokeEvent,
        compact: (_event, ctx) => compactEffect(ctx),
        tree: (_event, ctx) => treeEffect(ctx),
        cancel: cancelEffect,
        command: invokeCommand,
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          refs.removeHostCancellation?.();
          refs.removeHostCancellation = undefined;
          refs.activeContext = undefined;
          refs.activeSessionInput = undefined;
        }).pipe(Effect.andThen(stopRuntimeUnlockedEffect()), Effect.andThen(resources.stopChild)),
      );
      return service;
    }),
  );
