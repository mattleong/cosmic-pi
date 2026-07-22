/** Child runtime start/stop/replace controls. */
import * as Effect from "effect/Effect";
import {
  sessionEntryToContextMessages,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AdvisorEffectExecutor, AdvisorPlatform } from "../../boundary/executor.ts";
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
import type { ResolvedAdvisorConfig } from "../../config/options.ts";
import type { AdvisorReviewQueueServiceShape } from "../../queue/service.ts";
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
import type { AdvisorRuntimeServiceShape } from "../../runtime/runtime.ts";
import { PiCommandAdapter } from "../../boundary/host-commands.ts";
import {
  advisorRuntimeEffectsFromDriver,
  classifyFailure,
  incrementBounded,
  makeCancellationLatch,
} from "../controller-helpers.ts";
import type { AdvisorRuntimeDriver } from "../../runtime/types.ts";
import { AdvisorExtensionError, extensionError, type ParentAnchor } from "../controller-types.ts";
import type { AdvisorApplicationState } from "../state.ts";
import type { SessionRefs } from "./session-refs.ts";

export interface RuntimeDeps {
  readonly refs: SessionRefs;
  readonly getState: () => AdvisorApplicationState;
  readonly updateApplicationState: (
    update: (state: AdvisorApplicationState) => AdvisorApplicationState,
  ) => void;
  readonly mutateMetrics: (mutate: (next: AdvisorApplicationState["metrics"]) => void) => void;
  readonly currentConfig: () => ResolvedAdvisorConfig;
  readonly isPaused: () => boolean;
  readonly isStarted: () => boolean;
  readonly advanceDomainCounter: (
    key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
  ) => number;
  readonly clearPersistentTrajectory: () => void;
  readonly clearPendingRecovery: () => void;
  readonly stopStatusSpinner: () => void;
  readonly setAdvisorStatus: (ctx: ExtensionContext, text?: string) => void;
  readonly publishControllerSnapshot: () => Effect.Effect<void>;
  readonly publishControllerSnapshotNow: () => void;
  readonly startStatusSpinner: (ctx: ExtensionContext, owner: string) => void;
  readonly settleStatusSpinner: (ctx: ExtensionContext, owner: string) => void;
  readonly runSessionEffect: <A, E>(
    effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
  ) => Promise<A>;
  readonly parentExecutor: AdvisorEffectExecutor;
  readonly productionController: {
    readonly replaceChild: <A, E, R>(
      acquire: Effect.Effect<A, E, R>,
      release: (child: A) => Effect.Effect<void>,
    ) => Effect.Effect<A, E, R>;
    readonly stopChild: () => Effect.Effect<void>;
  };
  readonly productionRuntimeService: AdvisorRuntimeServiceShape;
  readonly productionQueueService: AdvisorReviewQueueServiceShape;
  readonly createRuntime: ((executor: AdvisorEffectExecutor) => AdvisorRuntimeDriver) | undefined;
  readonly notifyBestEffort: (
    ctx: Pick<ExtensionContext, "ui">,
    message: string,
    level: "info" | "warning" | "error",
  ) => void;
  readonly seedFromMessages: (messages: readonly unknown[]) => string;
  readonly activeSeed: (ctx: ExtensionContext) => string;
  readonly fingerprint: () => string;
  readonly parentAnchor: (ctx: ExtensionContext) => ParentAnchor;
  readonly recordUsage: (
    target: AdvisorApplicationState["metrics"],
    usage: AdvisorUsageTelemetry,
    runtimeConfig: ResolvedAdvisorConfig,
  ) => AdvisorApplicationState["metrics"];
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
      d.updateApplicationState((state) => ({ ...state, started: false }));
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
        Effect.andThen(d.publishControllerSnapshot()),
      );
    });
  const cancelActiveChildStartEffect = (): Effect.Effect<void> =>
    Effect.sync(() => {
      // The start token wins the race and its acquisition finalizer disposes only that child.
      // Do not abort the reusable refs.runtime service: a delayed abort could hit its replacement.
      refs.activeChildStart?.cancel();
      refs.activeChildStart = undefined;
    });
  const stopRuntimeEffect = (): Effect.Effect<void> =>
    cancelActiveChildStartEffect().pipe(Effect.andThen(d.productionController.stopChild()));
  const stopRuntime = (): Promise<void> => d.runSessionEffect(stopRuntimeEffect());

  const startRuntimeEffect = (
    ctx: ExtensionContext,
    restoration: "preserve-live" | "restore-branch" = "preserve-live",
    allowDisabled = false,
  ): Effect.Effect<number | undefined> =>
    Effect.suspend(() => {
      const startEpoch = d.advanceDomainCounter("epoch");
      let nextRuntime: AdvisorRuntimeServiceShape | undefined;
      const acquire = Effect.gen(function* () {
        yield* stopRuntimeUnlockedEffect();
        if (
          startEpoch !== d.getState().epoch ||
          d.isPaused() ||
          (!d.currentConfig().enabled && !allowDisabled) ||
          !d.currentConfig().configured
        )
          return undefined;
        const sessionInput = refs.activeSessionInput;
        if (!sessionInput) return undefined;
        nextRuntime = d.createRuntime
          ? advisorRuntimeEffectsFromDriver(d.createRuntime(d.parentExecutor))
          : d.productionRuntimeService;
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
        const startCancellation = makeCancellationLatch();
        refs.activeChildStart = startCancellation;
        const startOptions = {
          ctx: {
            cwd: sessionInput.cwd,
            modelRegistry: sessionInput.modelRegistry,
          },
          config: runtimeConfig,
          seed: startSeed,
          stateSummary: refs.latestStateSummary,
          ...(refs.instructions.content ? { instructions: refs.instructions.content } : {}),
          onUsage: (usage: AdvisorUsageTelemetry) => {
            if (startEpoch !== d.getState().epoch) return;
            d.updateApplicationState((state) => ({
              ...state,
              metrics: d.recordUsage(state.metrics, usage, runtimeConfig),
            }));
          },
          onDiagnostic: (message: string) => {
            if (d.getState().reportedDiagnostics.includes(message)) return;
            d.updateApplicationState((state) => ({
              ...state,
              reportedDiagnostics: [...state.reportedDiagnostics, message],
            }));
            d.notifyBestEffort(ctx, message, "warning");
          },
        };
        yield* nextRuntime.start(startOptions).pipe(
          Effect.mapError(
            (error) =>
              new AdvisorExtensionError({ operation: "child startup", message: error.message }),
          ),
          Effect.raceFirst(
            startCancellation.await.pipe(
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
          yield* nextRuntime.dispose();
          return undefined;
        }
        const nextQueue = yield* d.productionQueueService.make(nextRuntime, {
          onCheckpointStart: (request) => {
            d.startStatusSpinner(ctx, request.checkpointId);
            d.publishControllerSnapshotNow();
          },
          onCheckpointSettled: (request) => {
            d.settleStatusSpinner(ctx, request.checkpointId);
            d.publishControllerSnapshotNow();
          },
          onRuntimeReset: () => {
            if (startEpoch !== d.getState().epoch) return;
            d.mutateMetrics((next) => {
              next.childResets = incrementBounded(next.childResets);
            });
          },
          getReprimeState: () => ({
            seed: d.activeSeed(ctx),
            stateSummary: refs.latestStateSummary,
          }),
        });
        if (startEpoch !== d.getState().epoch) {
          yield* nextQueue.disposeEffect();
          return undefined;
        }
        if (refs.childStartedOnce)
          d.mutateMetrics((next) => {
            next.childResets = incrementBounded(next.childResets);
          });
        refs.childStartedOnce = true;
        refs.runtimeCursor = { anchor: d.parentAnchor(ctx), fingerprint: d.fingerprint() };
        refs.queue = nextQueue;
        d.updateApplicationState((state) => ({ ...state, started: true }));
        yield* d.publishControllerSnapshot();
        return startEpoch;
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            refs.activeChildStart = undefined;
            if (nextRuntime) yield* nextRuntime.dispose();
            if (refs.runtime === nextRuntime) refs.runtime = undefined;
            if (startEpoch === d.getState().epoch) {
              const kind = classifyFailure(error);
              d.mutateMetrics((next) => {
                next.failure += 1;
                next.outcomes.failures += 1;
                next.lastAction = "failure";
                next.lastFailureKind = kind;
              });
              if (!d.getState().reportedFailures.includes(kind)) {
                d.updateApplicationState((state) => ({
                  ...state,
                  reportedFailures: [...state.reportedFailures, kind],
                }));
                d.notifyBestEffort(
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
            acquire.pipe(
              Effect.onInterrupt(() =>
                nextRuntime
                  ? nextRuntime.dispose().pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          if (refs.runtime === nextRuntime) refs.runtime = undefined;
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            ),
            () => stopRuntimeUnlockedEffect(),
          ),
        ),
      );
    });
  const startRuntime = (
    ctx: ExtensionContext,
    restoration: "preserve-live" | "restore-branch" = "preserve-live",
    allowDisabled = false,
  ): Promise<number | undefined> =>
    d.runSessionEffect(startRuntimeEffect(ctx, restoration, allowDisabled));

  const runWithExplicitRuntimeEffect = <T>(
    ctx: ExtensionContext,
    action: () => T,
  ): Effect.Effect<T | undefined> =>
    Effect.suspend(() => {
      const owner = ++refs.explicitStartSequence;
      const expectedCancellationEpoch = d.getState().cancellationEpoch;
      refs.pendingExplicitStart = owner;
      return (
        d.isStarted()
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
    stopRuntime,
    startRuntimeEffect,
    startRuntime,
    runWithExplicitRuntimeEffect,
  };
};
