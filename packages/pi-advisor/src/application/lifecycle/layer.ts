import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Scope from "effect/Scope";
import { advisorDelay } from "../../boundary/clock.ts";
import type { AdvisorPlatform } from "../../boundary/executor.ts";
import { activeContextMessages } from "../../boundary/host-context.ts";
import { createLedgerFingerprint } from "../../checkpoint/ledger.ts";
import { makeCheckpointOrchestrator } from "../../checkpoint/orchestrator.ts";
import {
  ADVISOR_FAST_MODE,
  ADVISOR_RECENT_CONTEXT_CHARS,
  ADVISOR_THINKING_LEVEL,
  normalizeAdvisorConfig,
} from "../../config/options.ts";
import { ConfigStore } from "../../config/store.ts";
import { FailureLogger } from "../../logging/logger.ts";
import type { AdvisorReviewQueue } from "../../queue/review-queue.ts";
import { buildAdvisorContext } from "../../review/context.ts";
import { AdvisorRuntimeService } from "../../runtime/runtime.ts";
import { makeAdvisorResourceState } from "../../runtime/resource-state.ts";
import { handleAdvisorCommand } from "../../settings/controller.ts";
import { makeAdvisorStatusService } from "../../status/service.ts";
import {
  AdvisorController,
  extensionError,
  type AdvisorControllerApplicationOptions,
} from "../controller.ts";
import { initialAdvisorApplicationState, makeAdvisorApplicationStateStore } from "../state.ts";
import { makeLifecycleApplicationState } from "./application-state.ts";
import { makeCommandWorkflows } from "./commands.ts";
import { makeCheckpointControls } from "./checkpoint.ts";
import { makeDeliver } from "./delivery.ts";
import { makeLifecycleEvents } from "./events.ts";
import { makeLedgerPersistence } from "./ledger.ts";
import { makeRuntimeControls } from "./runtime.ts";
import { createSessionRefs } from "./session-refs.ts";
import { makeLifecycleStatusControls } from "./status.ts";

export const advisorControllerApplicationLayer = (options: AdvisorControllerApplicationOptions) =>
  Layer.effect(
    AdvisorController,
    Effect.gen(function* () {
      const { pi } = options;
      const productionRuntimeService = yield* AdvisorRuntimeService;
      const configStore = yield* ConfigStore;
      const failureLogger = yield* FailureLogger;
      const applicationScope = yield* Effect.scope;
      const applicationResourceScope = yield* Scope.fork(applicationScope);
      const platformContext = yield* Effect.context<AdvisorPlatform>();
      const resources = yield* makeAdvisorResourceState();
      const executor = options.executor;
      const checkpointOrchestrator = yield* makeCheckpointOrchestrator(executor);
      const statusService = yield* makeAdvisorStatusService();
      const refs = createSessionRefs();
      const applicationStateStore = makeAdvisorApplicationStateStore(
        initialAdvisorApplicationState(normalizeAdvisorConfig({}, "")),
      );

      const {
        captureCommandSnapshot,
        updateApplicationState,
        updateMetrics,
        currentConfig,
        mutateTrajectory,
        advanceDomainCounter,
        recordReceipt,
        clearPendingReceipt,
        clearPendingRecovery,
        initializeSession,
        beginUserRequest,
        cancelRequest,
        commitConfig,
        resetSessionTreeDomain,
      } = makeLifecycleApplicationState({
        store: applicationStateStore,
        refs,
        activeCheckpointCount: checkpointOrchestrator.activeCount,
      });
      const { stopStatusSpinner, setAdvisorStatus, startStatusSpinner, settleStatusSpinner } =
        makeLifecycleStatusControls({ statusService });

      const seedFromMessages = (messages: readonly unknown[]): string =>
        buildAdvisorContext({
          messages,
          candidate: refs.lastCandidate?.candidate ?? "[No completed candidate at this cursor.]",
          maxChars: ADVISOR_RECENT_CONTEXT_CHARS,
        }).transcript;
      const activeSeed = (ctx: ExtensionContext): string =>
        seedFromMessages(activeContextMessages(ctx));

      const fingerprint = (): string =>
        createLedgerFingerprint({
          provider: currentConfig().provider ?? "",
          model: currentConfig().model ?? "",
          cwd: refs.activeSessionInput?.cwd ?? "",
          guidance: refs.instructions.content ?? "",
          fastMode: ADVISOR_FAST_MODE,
          thinkingLevel: ADVISOR_THINKING_LEVEL,
        });

      const clearPersistentTrajectoryResources = (): void => {
        refs.activeTrajectoryResource?.cancelTimer?.();
        refs.activeTrajectoryResource = undefined;
        refs.activeToolCalls.clear();
      };
      const clearPersistentTrajectory = (): void => {
        clearPersistentTrajectoryResources();
        updateApplicationState((state) => ({ ...state, activeTrajectory: undefined }));
      };

      const {
        stopRuntimeUnlockedEffect,
        stopRuntimeEffect,
        startRuntimeEffect,
        runWithExplicitRuntimeEffect,
      } = makeRuntimeControls({
        refs,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        updateMetrics,
        currentConfig,
        advanceDomainCounter,
        clearPersistentTrajectory,
        clearPendingRecovery,
        stopStatusSpinner,
        setAdvisorStatus,
        startStatusSpinner,
        settleStatusSpinner,
        productionController: resources,
        productionRuntimeService,
        queueScope: applicationResourceScope,
        seedFromMessages,
        activeSeed,
        fingerprint,
      });

      const { persistLedger, persistCurrentLedger } = makeLedgerPersistence({
        pi,
        refs,
        getState: () => applicationStateStore.get(),
        fingerprint,
      });

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
        updateMetrics,
        ingest,
        recordReceipt,
      });

      const { requestCheckpoint, awaitCatchUpEffectOwned } = makeCheckpointControls({
        refs,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        updateMetrics,
        currentConfig,
        cancelRequest,
        persistCurrentLedger,
        persistLedger,
        setAdvisorStatus,
        failureLogger,
        applicationScope: applicationResourceScope,
        checkpointOrchestrator,
        now: () => executor.now(),
        startRuntimeEffect,
        stopRuntimeEffect,
        deliver,
        fingerprint,
      });

      const { commandActions, applyCommittedConfigEffect } = makeCommandWorkflows({
        pi,
        refs,
        getState: () => applicationStateStore.get(),
        updateMetrics,
        cancelRequest,
        commitConfig,
        persistCurrentLedger,
        applicationScope: applicationResourceScope,
        checkpointOrchestrator,
        startRuntimeEffect,
        runWithExplicitRuntimeEffect,
        requestCheckpoint,
      });
      const persistCommandConfig = (patch: Parameters<typeof configStore.patch>[0], path: string) =>
        configStore.patch(patch, path, applyCommittedConfigEffect);

      const {
        sessionInitializeEffect,
        sessionShutdownEffect,
        compactEffect,
        treeEffect,
        dispatchEvent,
      } = makeLifecycleEvents({
        refs,
        pi,
        applicationScope: applicationResourceScope,
        getState: () => applicationStateStore.get(),
        updateApplicationState,
        updateMetrics,
        currentConfig,
        advanceDomainCounter,
        clearPersistentTrajectory,
        clearPersistentTrajectoryResources,
        clearPendingRecovery,
        clearPendingReceipt,
        initializeSession,
        beginUserRequest,
        cancelRequest,
        resetSessionTreeDomain,
        persistCurrentLedger,
        persistLedger,
        ingest,
        recordReceipt,
        mutateTrajectory,
        scheduleDelay: (milliseconds, task) => advisorDelay(executor, milliseconds, task),
        startRuntimeEffect,
        stopRuntimeEffect,
        stopRuntimeUnlockedEffect,
        runWithExplicitRuntimeEffect,
        requestCheckpoint,
        awaitCatchUpEffectOwned,
        checkpointOrchestrator,
        configStore,
        persistCommandConfig,
      });

      const service = AdvisorController.of({
        sessionInitialize: (input) =>
          sessionInitializeEffect(input).pipe(Effect.provide(platformContext)),
        sessionShutdown: sessionShutdownEffect,
        event: dispatchEvent,
        compact: compactEffect,
        tree: treeEffect,
        command: (args, ctx) =>
          Effect.suspend(() =>
            handleAdvisorCommand(
              args,
              ctx,
              { snapshot: captureCommandSnapshot(), persist: persistCommandConfig },
              commandActions,
            ),
          ).pipe(Effect.mapError(extensionError("command advisor"))),
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          advanceDomainCounter("epoch");
          refs.removeHostCancellation?.();
          refs.removeHostCancellation = undefined;
          refs.activeContext = undefined;
          refs.activeSessionInput = undefined;
        }).pipe(Effect.andThen(stopRuntimeUnlockedEffect()), Effect.andThen(resources.stopChild())),
      );
      return service;
    }),
  );
