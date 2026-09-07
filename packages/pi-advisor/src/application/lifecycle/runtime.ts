/** Child runtime start/stop/replace controls. */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { notifyAtHostBoundary } from "pi-cosmic-core";
import {
  sessionEntryToContextMessages,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  readAdvisorContextEntriesEffect,
  readAdvisorSessionBranchEffect,
} from "../../boundary/host-context.ts";
import {
  renderDurableReviewSummary,
  restoreCheckpointLedger,
  summarizeAdvisorReview,
} from "../../checkpoint/ledger.ts";
import { createAdvisorEmissionGuardState } from "../../review/emission-guard.ts";
import { classifyFailure } from "../../domain/runtime-error-classifier.ts";
import { recordUsageMetrics } from "../../domain/metrics.ts";
import * as Scope from "effect/Scope";
import { makeAdvisorReviewQueue, type AdvisorReviewQueue } from "../../queue/review-queue.ts";
import {
  emptyAdvisorFindingLifecycle,
  restoreAdvisorFindingLifecycle,
} from "../../review/finding-lifecycle.ts";
import {
  emptyAdvisorInterventionBudget,
  sanitizeInterventionBudgetSnapshot,
} from "../../review/intervention-budget.ts";
import { emptyAdvisorRoutingState, sanitizeAdvisorRoutingState } from "../../review/routing.ts";
import type { AdvisorUsageTelemetry } from "../../runtime/client.ts";
import type { AdvisorRuntimeServiceContract } from "../../runtime/runtime.ts";
import { AdvisorExtensionError, extensionError } from "../controller.ts";
import type { StateRead, StateWrite } from "./deps.ts";
import { readParentAnchor } from "./parent-session.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface RuntimeDeps extends StateRead, StateWrite {
  readonly refs: SessionRefs;
  readonly fingerprint: () => string;
  readonly advanceDomainCounter: (key: "epoch" | "parentTurnId") => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPendingRecovery: () => void;
  readonly stopStatusSpinner: () => void;
  readonly setAdvisorStatus: (ctx: ExtensionContext, text?: string) => void;
  readonly startStatusSpinner: (ctx: ExtensionContext, owner: string) => void;
  readonly settleStatusSpinner: (ctx: ExtensionContext, owner: string) => void;
  readonly productionController: {
    readonly replaceChild: <A, E, R>(
      acquire: Effect.Effect<A, E, R>,
      release: (child: A) => Effect.Effect<void>,
    ) => Effect.Effect<A, E, R>;
    readonly stopChild: () => Effect.Effect<void>;
  };
  readonly productionRuntimeService: AdvisorRuntimeServiceContract;
  readonly queueScope: Scope.Scope;
  readonly seedFromMessages: (messages: readonly unknown[]) => string;
  readonly activeSeed: (ctx: ExtensionContext) => string;
}

export const makeRuntimeControls = (d: RuntimeDeps) => {
  const refs = d.refs;
  const stopRuntimeUnlockedEffect = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      d.clearPersistentTrajectory();
      d.clearPendingRecovery();
      const oldQueue = refs.queue;
      const oldRuntime = refs.runtime;
      const statusContext = refs.activeContext;
      refs.queue = undefined;
      refs.runtime = undefined;
      refs.runtimeCursor = undefined;
      d.stopStatusSpinner();
      const disposal = oldQueue
        ? oldQueue.disposeEffect()
        : oldRuntime
          ? oldRuntime.dispose()
          : Effect.void;
      return disposal.pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (statusContext) d.setAdvisorStatus(statusContext);
          }),
        ),
      );
    });
  const cancelActiveChildStartEffect = (): Effect.Effect<void> =>
    Effect.suspend(() => {
      // The start token wins the race and its acquisition finalizer disposes only that child.
      // Do not abort the reusable refs.runtime service: a delayed abort could hit its replacement.
      const activeChildStart = refs.activeChildStart;
      refs.activeChildStart = undefined;
      return activeChildStart
        ? Deferred.succeed(activeChildStart, undefined).pipe(Effect.asVoid)
        : Effect.void;
    });
  const stopRuntimeEffect = (): Effect.Effect<void> =>
    cancelActiveChildStartEffect().pipe(Effect.andThen(d.productionController.stopChild()));

  const startRuntimeEffect = (
    ctx: ExtensionContext,
    restoration: "preserve-live" | "restore-branch" = "preserve-live",
    allowDisabled = false,
  ): Effect.Effect<number | undefined> =>
    Effect.suspend(() => {
      const startEpoch = d.advanceDomainCounter("epoch");
      let nextRuntime: AdvisorRuntimeServiceContract | undefined;
      let nextQueue: AdvisorReviewQueue | undefined;
      let startCancellation: Deferred.Deferred<void> | undefined;
      const releaseNextOwnedEffect = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          const queue = nextQueue;
          const runtime = nextRuntime;
          nextQueue = undefined;
          nextRuntime = undefined;
          if (queue && refs.queue === queue) {
            refs.queue = undefined;
            refs.runtimeCursor = undefined;
          }
          if (runtime && refs.runtime === runtime) refs.runtime = undefined;
          return queue ? queue.disposeEffect() : (runtime?.dispose() ?? Effect.void);
        });
      const acquire = Effect.gen(function* () {
        yield* stopRuntimeUnlockedEffect();
        if (
          startEpoch !== d.getState().epoch ||
          (!d.currentConfig().enabled && !allowDisabled) ||
          !d.currentConfig().configured
        )
          return undefined;
        const sessionInput = refs.activeSessionInput;
        if (!sessionInput) return undefined;
        nextRuntime = d.productionRuntimeService;
        refs.runtime = nextRuntime;
        const branch =
          restoration === "restore-branch"
            ? yield* readAdvisorSessionBranchEffect(ctx).pipe(
                Effect.mapError(extensionError("session branch read")),
              )
            : [];
        const contextEntries = yield* readAdvisorContextEntriesEffect(ctx).pipe(
          Effect.mapError(extensionError("session context read")),
        );
        const startSeed = d.seedFromMessages(contextEntries.flatMap(sessionEntryToContextMessages));
        const ledger =
          restoration === "restore-branch"
            ? restoreCheckpointLedger(branch, d.fingerprint())
            : undefined;
        if (restoration === "restore-branch") {
          d.updateApplicationState((state) => ({
            ...state,
            routing: ledger
              ? sanitizeAdvisorRoutingState({
                  cancellationLatched: ledger.routing.cancellationLatched,
                  completedPrimaryTurns: ledger.routing.completedPrimaryTurns,
                  immunityUntilCompletedTurn: ledger.routing.immunityUntilCompletedTurn,
                })
              : emptyAdvisorRoutingState(),
            interventionBudget: ledger
              ? sanitizeInterventionBudgetSnapshot(ledger.routing.interventionBudget)
              : emptyAdvisorInterventionBudget(),
            findingLifecycle: ledger
              ? restoreAdvisorFindingLifecycle(ledger.findingLifecycle)
              : emptyAdvisorFindingLifecycle(),
            emissionGuard: createAdvisorEmissionGuardState(ledger?.emissionHashes),
          }));
          refs.latestDurableSummary = ledger?.reviewSummary ?? summarizeAdvisorReview();
          refs.latestStateSummary = ledger ? renderDurableReviewSummary(ledger.reviewSummary) : "";
        }
        const runtimeConfig = { ...d.currentConfig() };
        startCancellation = yield* Deferred.make<void>();
        refs.activeChildStart = startCancellation;
        const baseStartOptions = {
          ctx: {
            cwd: sessionInput.cwd,
            modelRegistry: sessionInput.modelRegistry,
          },
          config: runtimeConfig,
          seed: startSeed,
          stateSummary: refs.latestStateSummary,
          onUsage: (usage: AdvisorUsageTelemetry) => {
            if (startEpoch !== d.getState().epoch) return;
            d.updateApplicationState((state) => ({
              ...state,
              metrics: recordUsageMetrics(state.metrics, usage),
            }));
          },
          onDiagnostic: (message: string) => {
            if (startEpoch !== d.getState().epoch) return;
            let accepted = false;
            d.updateApplicationState((state) => {
              if (startEpoch !== state.epoch || state.reportedDiagnostics.includes(message))
                return state;
              accepted = true;
              return {
                ...state,
                reportedDiagnostics: [...state.reportedDiagnostics, message],
              };
            });
            if (accepted) notifyAtHostBoundary(ctx, message, "warning");
          },
        };
        const startOptions =
          refs.instructions.content !== undefined && refs.instructions.content !== ""
            ? { ...baseStartOptions, instructions: refs.instructions.content }
            : baseStartOptions;
        yield* nextRuntime.start(startOptions).pipe(
          Effect.raceFirst(
            Deferred.await(startCancellation).pipe(
              Effect.andThen(
                Effect.fail(
                  new AdvisorExtensionError({
                    operation: "child startup",
                    message: "Advisor child startup became stale.",
                  }),
                ),
              ),
            ),
          ),
        );
        if (refs.activeChildStart === startCancellation) refs.activeChildStart = undefined;
        if (startEpoch !== d.getState().epoch) {
          yield* releaseNextOwnedEffect();
          return undefined;
        }
        nextQueue = yield* makeAdvisorReviewQueue(nextRuntime, {
          onCheckpointStart: (request) => {
            d.startStatusSpinner(ctx, request.checkpointId);
          },
          onCheckpointSettled: (request) => {
            d.settleStatusSpinner(ctx, request.checkpointId);
          },
          getReprimeState: () => ({
            seed: d.activeSeed(ctx),
            stateSummary: refs.latestStateSummary,
          }),
        }).pipe(Effect.provideService(Scope.Scope, d.queueScope));
        if (startEpoch !== d.getState().epoch) {
          yield* releaseNextOwnedEffect();
          return undefined;
        }
        refs.runtimeCursor = { anchor: readParentAnchor(ctx), fingerprint: d.fingerprint() };
        refs.queue = nextQueue;
        nextQueue = undefined;
        nextRuntime = undefined;
        return startEpoch;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (startCancellation && refs.activeChildStart === startCancellation)
              refs.activeChildStart = undefined;
            yield* releaseNextOwnedEffect();
            if (startEpoch === d.getState().epoch) {
              const kind = classifyFailure(error);
              d.setAdvisorStatus(ctx, "advisor: unavailable");
              d.updateMetrics((metrics) => ({ ...metrics, lastAction: "failure" }));
              if (!d.getState().reportedFailures.includes(kind)) {
                d.updateApplicationState((state) => ({
                  ...state,
                  reportedFailures: [...state.reportedFailures, kind],
                }));
                notifyAtHostBoundary(
                  ctx,
                  `Advisor ${kind} failure; primary work remains unaffected.`,
                  "warning",
                );
              }
            }
            return undefined;
          }),
        ),
      );
      return cancelActiveChildStartEffect().pipe(
        Effect.andThen(
          d.productionController.replaceChild(
            acquire.pipe(Effect.onInterrupt(releaseNextOwnedEffect)),
            () => stopRuntimeUnlockedEffect(),
          ),
        ),
      );
    });
  const runWithExplicitRuntimeEffect = <T>(
    ctx: ExtensionContext,
    action: () => T,
  ): Effect.Effect<T | undefined> =>
    Effect.suspend(() => {
      const owner = ++refs.explicitStartSequence;
      const expectedCancellationEpoch = d.getState().cancellationEpoch;
      refs.pendingExplicitStart = owner;
      return (
        refs.queue
          ? Effect.succeed(d.getState().epoch)
          : startRuntimeEffect(ctx, "preserve-live", true)
      ).pipe(
        Effect.map((runtimeEpoch) => {
          if (
            refs.pendingExplicitStart !== owner ||
            runtimeEpoch === undefined ||
            runtimeEpoch !== d.getState().epoch ||
            d.getState().cancellationEpoch !== expectedCancellationEpoch
          ) {
            if (refs.pendingExplicitStart === owner) refs.pendingExplicitStart = undefined;
            return undefined;
          }
          refs.pendingExplicitStart = undefined;
          return action();
        }),
      );
    });

  return {
    stopRuntimeUnlockedEffect,
    cancelActiveChildStartEffect,
    stopRuntimeEffect,
    startRuntimeEffect,
    runWithExplicitRuntimeEffect,
  };
};
