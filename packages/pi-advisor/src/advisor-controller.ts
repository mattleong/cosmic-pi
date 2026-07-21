import { stringifyJson } from "./boundary/json.ts";
import { snapshotData } from "./boundary/safe-data.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { makeAdvisorProjection, type AdvisorControllerSnapshot } from "./advisor-projection.ts";
import { makeAdvisorResourceState } from "./advisor-resource-state.ts";
import { makeCheckpointOrchestrator } from "./checkpoint-orchestrator.ts";
import { makeAdvisorStatusService } from "./status-service.ts";
import {
  advisorPlatformLayer,
  type AdvisorEffectExecutor,
  type AdvisorPlatform,
} from "./boundary/executor.ts";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { advisorDelay, advisorNow } from "./boundary/clock.ts";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { isRecord } from "./utils.ts";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { AdvisorModelError, type AdvisorUsageTelemetry } from "./client.ts";
import {
  AdvisorRuntimeService,
  advisorRuntimeServiceLayer,
  type AdvisorCheckpoint,
  type AdvisorRuntimeDriver,
  type AdvisorRuntimeServiceShape,
} from "./advisor-runtime.ts";
import {
  AdvisorReviewQueue,
  AdvisorReviewQueueService,
  advisorReviewQueueServiceLayer,
} from "./review-queue.ts";
import { redactSensitiveText, stringifyRedactedObservation } from "./observation-protocol.ts";
import {
  ADVISOR_CHECKPOINT_ENTRY_TYPE,
  createCheckpointLedger,
  createLedgerFingerprint,
  renderDurableReviewSummary,
  restoreCheckpointLedger,
  summarizeAdvisorReview,
  type AdvisorDurableReviewSummary,
} from "./checkpoint-ledger.ts";
import {
  getAdvisorConfigPath,
  normalizeAdvisorConfig,
  type ResolvedAdvisorConfig,
} from "./config.ts";
import {
  ConfigRepository,
  configRepositoryLayer,
  configRepositoryTestLayer,
} from "./config-repository.ts";
import { safeAdvisorLabel } from "./advisor-label.ts";
import { filterAdvisorFindingsWithRollback, rollbackAdvisorFindingDedupe } from "./dedupe.ts";
import { gateAdvisorFindings } from "./finding-gates.ts";
import {
  acknowledgeAdvisorFindings,
  advisorFindingLifecycleCounts,
  emptyAdvisorFindingLifecycle,
  reconcileAdvisorFindings,
  restoreAdvisorFindingLifecycle,
} from "./finding-lifecycle.ts";
import { commitAdvisorPerspective, selectAdvisorPerspective } from "./perspective-budget.ts";
import {
  canCorrectAdvisorIntervention,
  canDeliverAdvisorIntervention,
  commitAdvisorIntervention,
  emptyAdvisorInterventionBudget,
  sanitizeInterventionBudgetSnapshot,
} from "./intervention-budget.ts";
import {
  createAdvisorEmissionGuardState,
  evaluateAdvisorEmission,
  exportAdvisorEmissionRecords,
  highestAdvisorSeverity,
  rollbackAdvisorEmission,
  type AdvisorEmissionRollback,
} from "./emission-guard.ts";
import { buildAdvisorContext } from "./context.ts";
import type { AdvisorFailureDetails } from "./failure-log.ts";
import { FailureLogger, failureLoggerLayer, failureLoggerTestLayer } from "./failure-logger.ts";
import { HostNotifier, hostNotifierLayer, type HostNotifierShape } from "./host-notifier.ts";
import { loadAdvisorInstructionsEffect, type LoadedAdvisorInstructions } from "./instructions.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE, registerAdvisorReviewRenderer } from "./renderer.ts";
import {
  AdvisorReviewParseError,
  buildAdvisorAdvice,
  buildAdvisorPerspective,
  buildProgressSteer,
  buildRevisionSteer,
  canonicalAdvisorFindingFingerprint,
  sanitizeAdvisorReview,
  type AdvisorFinding,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "./review.ts";
import {
  armAdvisorInterruption,
  clearAdvisorCancellation,
  completeAdvisorPrimaryTurn,
  emptyAdvisorRoutingState,
  isAdvisorImmunityActive,
  latchAdvisorCancellation,
  routeAdvisorFinding,
  sanitizeAdvisorRoutingState,
  type AdvisorRoute,
} from "./routing.ts";
import { PiCommandAdapter } from "./pi-command-adapter.ts";
import {
  emptyAdvisorOutcomes,
  type AdvisorCommandActions,
  type AdvisorSessionMetrics,
  registerAdvisorCommands,
} from "./settings.ts";
import {
  advisorActiveToolCount,
  emptyAdvisorToolTrajectoryDetector,
  emptyAdvisorTrajectoryDetector,
  endAdvisorToolTrajectory,
  isMateriallyNovelAdvisorTerminal,
  LONG_TURN_REVIEW_MS,
  markConcreteAdvisorProgress,
  MAX_TRAJECTORY_EVIDENCE_CHARS,
  pushAdvisorTrajectory,
  startAdvisorToolTrajectory,
} from "./trajectory.ts";
import {
  initialAdvisorApplicationState,
  makeAdvisorApplicationStateStore,
  recordAdvisorReceipt,
  resetAdvisorRequestDomain,
  setAdvisorSpinnerOwner,
  type AdvisorActiveTrajectoryState,
  type AdvisorApplicationState,
} from "./advisor-application-state.ts";

export class AdvisorExtensionError extends Schema.TaggedErrorClass<AdvisorExtensionError>()(
  "AdvisorExtensionError",
  { operation: Schema.String, message: Schema.String },
) {}
const extensionError = (operation: string) => () =>
  new AdvisorExtensionError({ operation, message: `Advisor ${operation} failed.` });

const STATUS_KEY = "pi-advisor";
const STATUS_SPINNER_DELAY_MS = 200;
const STATUS_SPINNER_INTERVAL_MS = 120;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const ADVISOR_CATCH_UP_TIMEOUT_MS = 30_000;
type ReviewPhase = "final" | "progress";
type CheckpointSettlement = "completed" | "discarded" | "failed";
export type AdvisorCatchUpOutcome = CheckpointSettlement | "timeout" | "cancelled";
export const awaitAdvisorCatchUpEffect = (
  settlement: Effect.Effect<CheckpointSettlement>,
  timeoutMs: number,
  cancellation: Effect.Effect<"cancelled"> = Effect.never,
  onTimeout: Effect.Effect<void> = Effect.void,
): Effect.Effect<AdvisorCatchUpOutcome> =>
  settlement.pipe(
    Effect.raceFirst(Effect.sleep(timeoutMs).pipe(Effect.as("timeout" as const))),
    Effect.raceFirst(cancellation),
    Effect.flatMap((outcome) =>
      outcome === "timeout" ? onTimeout.pipe(Effect.as(outcome)) : Effect.succeed(outcome),
    ),
    Effect.withSpan("pi-advisor.catch-up"),
  );

interface AdvisorCheckpointHandle {
  invalidate(): void;
  cancel(): void;
  cancelEffect: Effect.Effect<void>;
  settlement: Effect.Effect<CheckpointSettlement>;
}
type ReviewSource =
  | "automatic-final"
  | "automatic-progress"
  | "automatic-perspective"
  | "automatic-catch-up"
  | "next"
  | "last"
  | "verify";

export type AdvisorSkipReason =
  | "disabled"
  | "empty"
  | "incomplete"
  | "pending-input"
  | "session-paused"
  | "unconfigured";

interface LastCandidate {
  candidate: string;
  generation: number;
  messages: unknown[];
  sessionEpoch: number;
}

type AdvisorHostEventHandler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;

type AdvisorHostCommandHandler = (
  args: string,
  ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
) => unknown | Promise<unknown>;

export interface AdvisorControllerShape {
  /** Synchronous Pi/TUI boundary; returns a deeply frozen projection only. */
  readonly getSnapshot: () => AdvisorControllerSnapshot;
  readonly publish: (snapshot: AdvisorControllerSnapshot) => Effect.Effect<void>;
  readonly refreshProjection: Effect.Effect<void>;
  readonly replaceChild: <A, E, R>(
    acquire: Effect.Effect<A, E, R>,
    release: (child: A) => Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>;
  readonly stopChild: () => Effect.Effect<void>;
  readonly sessionInitialize: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly sessionShutdown: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly event: (
    name: string,
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly compact: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly tree: (
    event: never,
    ctx: ExtensionContext,
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly cancel: (
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
  readonly command: (
    name: string,
    args: string,
    ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
  ) => Effect.Effect<unknown, AdvisorExtensionError>;
}

export class AdvisorController extends Context.Service<AdvisorController, AdvisorControllerShape>()(
  "pi-advisor/advisor-controller/AdvisorController",
) {}

export const advisorControllerLayer = Layer.effect(
  AdvisorController,
  Effect.gen(function* () {
    const resources = yield* makeAdvisorResourceState();
    const projection = yield* makeAdvisorProjection({
      config: normalizeAdvisorConfig({}, ""),
      metrics: emptySessionMetrics(),
      paused: false,
      started: false,
    });
    const unavailable = (operation: string) =>
      Effect.fail(
        new AdvisorExtensionError({
          operation,
          message: "Advisor application controller is not configured.",
        }),
      );
    const service = AdvisorController.of({
      getSnapshot: projection.getSnapshot,
      publish: (next) => projection.replace(next).pipe(Effect.orDie),
      refreshProjection: Effect.void,
      replaceChild: resources.replaceChild,
      stopChild: () => resources.stopChild,
      sessionInitialize: () => unavailable("session initialize"),
      sessionShutdown: () => unavailable("session shutdown"),
      event: (name) => unavailable(name),
      compact: () => unavailable("session compact"),
      tree: () => unavailable("session tree"),
      cancel: () => unavailable("cancel"),
      command: (name) => unavailable(`command ${name}`),
    });
    yield* Effect.addFinalizer(() => resources.stopChild);
    return service;
  }),
);

export interface AdvisorExtensionDependencies {
  loadConfig?: (path?: string) => ResolvedAdvisorConfig | Promise<ResolvedAdvisorConfig>;
  logFailure?: (
    configPath: string,
    details: AdvisorFailureDetails,
  ) => string | undefined | Promise<string | undefined>;
  createRuntime?: (executor: AdvisorEffectExecutor) => AdvisorRuntimeDriver;
  /** Test seam only. Production always uses the hard exported cap. */
  catchUpTimeoutMs?: number | undefined;
}

export interface AdvisorControllerApplicationOptions {
  readonly pi: ExtensionAPI;
  readonly executor: AdvisorEffectExecutor;
  readonly dependencies: AdvisorExtensionDependencies;
  readonly eventHandlers: Map<string, AdvisorHostEventHandler>;
  readonly commandHandlers: Map<string, AdvisorHostCommandHandler>;
  readonly commandDefinitions: Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>;
}

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
      const configRepository = yield* ConfigRepository;
      const failureLogger = yield* FailureLogger;
      const hostNotifier = yield* HostNotifier;
      const applicationScope = yield* Effect.scope;
      const platformContext = yield* Effect.context<AdvisorPlatform>();
      const resources = yield* makeAdvisorResourceState();
      const checkpointOrchestrator = yield* makeCheckpointOrchestrator(options.executor);
      const statusService = yield* makeAdvisorStatusService(options.executor);
      const projection = yield* makeAdvisorProjection({
        config: normalizeAdvisorConfig({}, ""),
        metrics: emptySessionMetrics(),
        paused: false,
        started: false,
      });
      const productionController = {
        publish: (next: AdvisorControllerSnapshot) => projection.replace(next).pipe(Effect.orDie),
        publishNow: projection.replaceNow,
        replaceChild: resources.replaceChild,
        stopChild: () => resources.stopChild,
      };
      const capturingPi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property === "on") {
            return (name: string, handler: AdvisorHostEventHandler) => {
              options.eventHandlers.set(name, handler);
            };
          }
          if (property === "registerCommand") {
            return (name: string, definition: Parameters<ExtensionAPI["registerCommand"]>[1]) => {
              options.commandDefinitions.set(name, definition);
              options.commandHandlers.set(name, definition.handler as AdvisorHostCommandHandler);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }) as ExtensionAPI;
      const parentExecutor: AdvisorEffectExecutor = options.executor;
      let parentGeneration = 0;
      let removeHostCancellation: (() => void) | undefined;
      let configRevision = 0;
      let checkpointId = 0;
      let queue: AdvisorReviewQueue | undefined;
      let runtime: AdvisorRuntimeServiceShape | undefined;
      let runtimeCursor: { anchor: string | null; fingerprint: string } | undefined;
      let activeContext: ExtensionContext | undefined;
      const applicationStateStore = makeAdvisorApplicationStateStore(
        initialAdvisorApplicationState(normalizeAdvisorConfig({}, "")),
      );
      let instructions: LoadedAdvisorInstructions = { paths: [] };
      let pendingExplicitStart: number | undefined;
      let explicitStartSequence = 0;
      let lastCandidate: LastCandidate | undefined;
      let childStartedOnce = false;
      let trajectorySequence = 0;
      let activeTrajectoryResource:
        | { readonly id: number; readonly ctx: ExtensionContext; cancelTimer?: () => void }
        | undefined;
      let perspectiveCheckpointUsed = false;

      const controllerSnapshot = (state: AdvisorApplicationState): AdvisorControllerSnapshot => ({
        config: state.config,
        metrics: {
          ...state.metrics,
          ...state.resourceSummary,
          childResets: state.metrics.childResets ?? 0,
          guidancePaths: state.guidancePaths,
          hasLastCandidate: state.hasLastCandidate,
          findingLifecycle: advisorFindingLifecycleCounts(state.findingLifecycle),
          interventionBudget: state.interventionBudget,
          paused: state.paused,
          reviewNext: state.reviewNext,
        },
        paused: state.paused,
        started: state.started,
      });
      const refreshResourceSummary = (): AdvisorApplicationState =>
        applicationStateStore.transition((state) => ({
          ...state,
          resourceSummary: {
            activeToolNames: queue?.activeToolNames ?? [],
            backlog: queue?.backlog ?? 0,
            backgroundState: queue?.hasActiveCheckpoint
              ? "reviewing"
              : queue && queue.pendingCheckpoints > 0
                ? "queued"
                : "idle",
            processedSequence: queue?.processedThrough ?? 0,
            queuedReviews: queue?.pendingCheckpoints ?? 0,
            sequence: queue?.sequence ?? 0,
          },
        }));
      const publishControllerSnapshotNow = (): void => {
        const state = refreshResourceSummary();
        productionController.publishNow(controllerSnapshot(state));
      };
      const publishControllerSnapshot = (): Effect.Effect<void> => {
        const state = refreshResourceSummary();
        return productionController.publish(controllerSnapshot(state));
      };
      const updateApplicationState = (
        update: (state: AdvisorApplicationState) => AdvisorApplicationState,
      ): void => {
        applicationStateStore.transition(update);
        publishControllerSnapshotNow();
      };
      const cloneMetrics = (current: AdvisorSessionMetrics): AdvisorSessionMetrics => ({
        ...current,
        outcomes: { ...current.outcomes },
        ...(current.skippedReviews
          ? { skippedReviews: { ...current.skippedReviews } }
          : { skippedReviews: {} }),
        ...(current.usageByModel
          ? {
              usageByModel: Object.fromEntries(
                Object.entries(current.usageByModel).map(([key, usage]) => [key, { ...usage }]),
              ),
            }
          : { usageByModel: {} }),
      });
      const mutateMetrics = (mutate: (next: AdvisorSessionMetrics) => void): void => {
        updateApplicationState((state) => {
          const next = cloneMetrics(state.metrics);
          mutate(next);
          return { ...state, metrics: next };
        });
      };
      const currentConfig = (): ResolvedAdvisorConfig => applicationStateStore.get().config;
      const isPaused = (): boolean => applicationStateStore.get().paused;
      const isStarted = (): boolean => applicationStateStore.get().started;
      const mutateTrajectory = (
        id: number,
        mutate: (next: AdvisorActiveTrajectoryState) => AdvisorActiveTrajectoryState,
      ): AdvisorActiveTrajectoryState | undefined => {
        let result: AdvisorActiveTrajectoryState | undefined;
        updateApplicationState((state) => {
          if (!state.activeTrajectory || state.activeTrajectory.id !== id) return state;
          result = mutate({ ...state.activeTrajectory });
          return { ...state, activeTrajectory: result };
        });
        return result;
      };
      const setDomainCounter = (
        key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
        value: number,
      ): number => {
        updateApplicationState((state) => ({ ...state, [key]: value }));
        return value;
      };
      const advanceDomainCounter = (
        key: "epoch" | "cancellationEpoch" | "parentTurnId" | "requestSequence",
      ): number => setDomainCounter(key, applicationStateStore.get()[key] + 1);
      const recordReceipt = (ids: readonly string[]): void => {
        updateApplicationState((state) =>
          recordAdvisorReceipt(
            {
              ...state,
              cancellationEpoch: applicationStateStore.get().cancellationEpoch,
              requestSequence: applicationStateStore.get().requestSequence,
            },
            ids,
          ),
        );
      };
      const clearPendingReceipt = (): void => {
        updateApplicationState((state) => ({ ...state, pendingReceipt: undefined }));
      };
      const latchCancellation = (): void => {
        updateApplicationState((state) => ({
          ...state,
          routing: latchAdvisorCancellation(state.routing),
        }));
      };
      const resetRequestDomain = (resetLifecycle = false): void => {
        updateApplicationState((state) => {
          const reset = resetAdvisorRequestDomain(state);
          return {
            ...reset,
            cancellationEpoch: state.cancellationEpoch,
            requestSequence: state.requestSequence,
            findingLifecycle: resetLifecycle
              ? emptyAdvisorFindingLifecycle()
              : state.findingLifecycle,
          };
        });
        perspectiveCheckpointUsed = false;
      };
      const activeToolCalls = new Map<string, { toolName: string; args: unknown }>();
      let latestStateSummary = "";
      let latestDurableSummary: AdvisorDurableReviewSummary = summarizeAdvisorReview();

      const executorForSession = (): AdvisorEffectExecutor | undefined => parentExecutor;
      const runSessionEffect = <A, E>(
        effect: Effect.Effect<A, E, AdvisorPlatform | PiCommandAdapter>,
      ): Promise<A> => {
        const executor = executorForSession();
        return executor
          ? executor.run(effect.pipe(Effect.provideService(PiCommandAdapter, commandAdapter)))
          : Promise.reject(
              new AdvisorExtensionError({
                operation: "session execution",
                message: "Advisor session runtime is not active.",
              }),
            );
      };

      const notifyBestEffort = hostNotifier.notify;

      const stopStatusSpinner = (): void => {
        statusService.clear();
        updateApplicationState((state) => setAdvisorSpinnerOwner(state));
      };

      const setAdvisorStatus = (ctx: ExtensionContext, text?: string): void => {
        stopStatusSpinner();
        try {
          ctx.ui.setStatus(STATUS_KEY, text);
        } catch {
          // Status rendering cannot prevent resource cleanup.
        }
      };

      const renderReviewStatus = (ctx: ExtensionContext, frameIndex: number): void => {
        const renderConfig = currentConfig();
        const frame =
          STATUS_SPINNER_FRAMES[frameIndex % STATUS_SPINNER_FRAMES.length] ??
          STATUS_SPINNER_FRAMES[0];
        const model =
          renderConfig.provider && renderConfig.model
            ? ctx.modelRegistry.find(renderConfig.provider, renderConfig.model)
            : undefined;
        const effort = model
          ? clampThinkingLevel(model, renderConfig.thinkingLevel)
          : renderConfig.thinkingLevel;
        try {
          ctx.ui.setStatus(
            STATUS_KEY,
            `${frame} ${redactSensitiveText(renderConfig.model ?? "advisor").slice(0, 256)}:${effort} advising…`,
          );
        } catch {
          stopStatusSpinner();
        }
      };

      const startStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
        updateApplicationState((state) => setAdvisorSpinnerOwner(state, owner));
        statusService.start({
          owner,
          delayMs: STATUS_SPINNER_DELAY_MS,
          intervalMs: STATUS_SPINNER_INTERVAL_MS,
          animated: ctx.mode === "tui",
          frameCount: STATUS_SPINNER_FRAMES.length,
          render: (frame) => {
            updateApplicationState((state) => ({
              ...state,
              spinner: { ...state.spinner, frame },
            }));
            renderReviewStatus(ctx, frame);
          },
        });
      };

      const settleStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
        if (!statusService.settle(owner)) return;
        updateApplicationState((state) => setAdvisorSpinnerOwner(state));
        try {
          ctx.ui.setStatus(STATUS_KEY, isPaused() ? "advisor: paused" : undefined);
        } catch {
          // Status rendering cannot prevent resource cleanup.
        }
      };

      const recordSkip = (reason: AdvisorSkipReason): void => {
        mutateMetrics((next) => {
          const skipped = next.skippedReviews ?? {};
          next.skippedReviews = { ...skipped, [reason]: incrementBounded(skipped[reason]) };
        });
      };

      const recordUsage = (
        target: AdvisorSessionMetrics,
        usage: AdvisorUsageTelemetry,
        runtimeConfig: ResolvedAdvisorConfig,
      ): AdvisorSessionMetrics => {
        const next = cloneMetrics(target);
        next.cacheReadTokens = (next.cacheReadTokens ?? 0) + usage.cacheReadTokens;
        next.cacheWriteTokens = (next.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
        next.cost = (next.cost ?? 0) + usage.cost;
        next.inputTokens = (next.inputTokens ?? 0) + usage.inputTokens;
        next.modelResponses = incrementBounded(next.modelResponses);
        next.outputTokens = (next.outputTokens ?? 0) + usage.outputTokens;
        next.totalTokens = (next.totalTokens ?? 0) + usage.totalTokens;

        const provider = runtimeConfig.provider ?? "unknown";
        const model = runtimeConfig.model ?? "unknown";
        const key = stringifyJson([provider, model]);
        const previous = next.usageByModel?.[key];
        next.usageByModel = {
          ...next.usageByModel,
          [key]: {
            provider,
            model,
            responses: incrementBounded(previous?.responses),
            cacheReadTokens: (previous?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
            cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
            cost: (previous?.cost ?? 0) + usage.cost,
            inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
            outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
            totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
          },
        };
        return next;
      };

      const recordReviewDuration = (
        target: AdvisorSessionMetrics,
        startedAt: number,
      ): AdvisorSessionMetrics => {
        const next = cloneMetrics(target);
        const duration = Math.max(
          0,
          (parentExecutor ? advisorNow(parentExecutor) : startedAt) - startedAt,
        );
        next.latestDurationMs = duration;
        next.settledReviews = incrementBounded(next.settledReviews);
        next.totalDurationMs = (next.totalDurationMs ?? 0) + duration;
        return next;
      };

      const activeSeed = (ctx: ExtensionContext): string =>
        buildAdvisorContext({
          messages: activeContextMessages(ctx),
          candidate: lastCandidate?.candidate ?? "[No completed candidate at this cursor.]",
          maxChars: currentConfig().maxContextChars,
        }).transcript;

      const fingerprint = (ctx: ExtensionContext): string =>
        createLedgerFingerprint({
          provider: currentConfig().provider ?? "",
          model: currentConfig().model ?? "",
          cwd: ctx.cwd,
          guidance: instructions.content ?? "",
          fastMode: currentConfig().fastMode,
          thinkingLevel: currentConfig().thinkingLevel,
        });

      const parentAnchor = (ctx: ExtensionContext): string | null => {
        if (typeof ctx.sessionManager.getBranch !== "function") {
          return ctx.sessionManager.getLeafId?.() ?? null;
        }
        const branch = ctx.sessionManager.getBranch();
        for (let index = branch.length - 1; index >= 0; index -= 1) {
          const entry = branch[index];
          if (
            entry &&
            !(entry.type === "custom" && entry.customType === ADVISOR_CHECKPOINT_ENTRY_TYPE)
          )
            return entry.id;
        }
        return null;
      };

      const lifecycleScope = (ctx: ExtensionContext): string => {
        const sessionId = ctx.sessionManager.getSessionId?.();
        if (sessionId) return `session:${sessionId}`;
        const branch = ctx.sessionManager.getBranch?.() ?? [];
        const root = branch.find(
          (entry) =>
            !(entry.type === "custom" && entry.customType === ADVISOR_CHECKPOINT_ENTRY_TYPE),
        );
        return `branch:${root?.id ?? parentAnchor(ctx) ?? "root"}`;
      };

      const branchContains = (ctx: ExtensionContext, anchor: string | null): boolean => {
        if (!anchor || typeof ctx.sessionManager.getBranch !== "function") return true;
        return ctx.sessionManager.getBranch().some((entry) => entry.id === anchor);
      };

      const clearPersistentTrajectory = (): void => {
        activeTrajectoryResource?.cancelTimer?.();
        activeTrajectoryResource = undefined;
        activeToolCalls.clear();
        updateApplicationState((state) => ({ ...state, activeTrajectory: undefined }));
      };

      const clearPendingRecovery = (): void => {
        const pending = applicationStateStore.get().pendingPersistentRecovery;
        if (pending) {
          updateApplicationState((state) => {
            const nextMetrics = cloneMetrics(state.metrics);
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
          });
        } else {
          updateApplicationState((state) => ({
            ...state,
            pendingPersistentRecovery: undefined,
            abortInProgress: undefined,
          }));
        }
      };

      let activeChildStart: CancellationLatch | undefined;
      const stopRuntimeUnlockedEffect = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          clearPersistentTrajectory();
          clearPendingRecovery();
          const oldQueue = queue;
          const oldRuntime = runtime;
          const statusContext = activeContext;
          queue = undefined;
          runtime = undefined;
          runtimeCursor = undefined;
          updateApplicationState((state) => ({ ...state, started: false }));
          stopStatusSpinner();
          const disposal = oldQueue
            ? oldQueue.disposeEffect()
            : oldRuntime
              ? oldRuntime.dispose()
              : Effect.void;
          return disposal.pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (statusContext) setAdvisorStatus(statusContext);
              }),
            ),
            Effect.andThen(publishControllerSnapshot()),
          );
        });
      const cancelActiveChildStartEffect = (): Effect.Effect<void> =>
        Effect.sync(() => {
          // The start token wins the race and its acquisition finalizer disposes only that child.
          // Do not abort the reusable runtime service: a delayed abort could hit its replacement.
          activeChildStart?.cancel();
          activeChildStart = undefined;
        });
      const stopRuntimeEffect = (): Effect.Effect<void> =>
        cancelActiveChildStartEffect().pipe(Effect.andThen(productionController.stopChild()));
      const stopRuntime = (): Promise<void> => runSessionEffect(stopRuntimeEffect());

      const startRuntimeEffect = (
        ctx: ExtensionContext,
        restoration: "preserve-live" | "restore-branch" = "preserve-live",
        allowDisabled = false,
      ): Effect.Effect<number | undefined> =>
        Effect.suspend(() => {
          const startEpoch = advanceDomainCounter("epoch");
          let nextRuntime: AdvisorRuntimeServiceShape | undefined;
          const acquire = Effect.gen(function* () {
            yield* stopRuntimeUnlockedEffect();
            if (
              startEpoch !== applicationStateStore.get().epoch ||
              isPaused() ||
              (!currentConfig().enabled && !allowDisabled) ||
              !currentConfig().configured
            )
              return undefined;
            const executor = executorForSession();
            if (!executor) return undefined;
            nextRuntime = createRuntime
              ? advisorRuntimeEffectsFromDriver(createRuntime(executor))
              : productionRuntimeService;
            runtime = nextRuntime;
            const branch =
              typeof ctx.sessionManager.getBranch === "function"
                ? ctx.sessionManager.getBranch()
                : [];
            const ledger =
              restoration === "restore-branch"
                ? restoreCheckpointLedger(branch, fingerprint(ctx))
                : undefined;
            if (restoration === "restore-branch") {
              updateApplicationState((state) => ({
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
              latestStateSummary = "";
              latestDurableSummary = summarizeAdvisorReview();
              if (ledger) {
                latestDurableSummary = ledger.reviewSummary;
                latestStateSummary = renderDurableReviewSummary(ledger.reviewSummary);
              }
            }
            const runtimeConfig = { ...currentConfig() };
            const startCancellation = makeCancellationLatch();
            activeChildStart = startCancellation;
            const startOptions = {
              ctx,
              config: runtimeConfig,
              seed: activeSeed(ctx),
              stateSummary:
                restoration === "restore-branch" && ledger
                  ? renderDurableReviewSummary(ledger.reviewSummary)
                  : latestStateSummary,
              ...(instructions.content ? { instructions: instructions.content } : {}),
              onUsage: (usage: AdvisorUsageTelemetry) => {
                if (startEpoch !== applicationStateStore.get().epoch) return;
                updateApplicationState((state) => ({
                  ...state,
                  metrics: recordUsage(state.metrics, usage, runtimeConfig),
                }));
              },
              onDiagnostic: (message: string) => {
                if (applicationStateStore.get().reportedDiagnostics.includes(message)) return;
                updateApplicationState((state) => ({
                  ...state,
                  reportedDiagnostics: [...state.reportedDiagnostics, message],
                }));
                notifyBestEffort(ctx, message, "warning");
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
            if (activeChildStart === startCancellation) activeChildStart = undefined;
            if (startEpoch !== applicationStateStore.get().epoch || executor !== parentExecutor) {
              yield* nextRuntime.dispose();
              return undefined;
            }
            const nextQueue = yield* productionQueueService.make(nextRuntime, {
              onCheckpointStart: (request) => {
                startStatusSpinner(ctx, request.checkpointId);
                publishControllerSnapshotNow();
              },
              onCheckpointSettled: (request) => {
                settleStatusSpinner(ctx, request.checkpointId);
                publishControllerSnapshotNow();
              },
              onRuntimeReset: () => {
                if (startEpoch !== applicationStateStore.get().epoch) return;
                mutateMetrics((next) => {
                  next.childResets = incrementBounded(next.childResets);
                });
              },
              getReprimeState: () => ({ seed: activeSeed(ctx), stateSummary: latestStateSummary }),
            });
            if (startEpoch !== applicationStateStore.get().epoch || executor !== parentExecutor) {
              yield* nextQueue.disposeEffect();
              return undefined;
            }
            if (childStartedOnce)
              mutateMetrics((next) => {
                next.childResets = incrementBounded(next.childResets);
              });
            childStartedOnce = true;
            runtimeCursor = { anchor: parentAnchor(ctx), fingerprint: fingerprint(ctx) };
            queue = nextQueue;
            updateApplicationState((state) => ({ ...state, started: true }));
            yield* publishControllerSnapshot();
            return startEpoch;
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                activeChildStart = undefined;
                if (nextRuntime) yield* nextRuntime.dispose();
                if (runtime === nextRuntime) runtime = undefined;
                if (startEpoch === applicationStateStore.get().epoch) {
                  const kind = classifyFailure(error);
                  mutateMetrics((next) => {
                    next.failure += 1;
                    next.outcomes.failures += 1;
                    next.lastAction = "failure";
                    next.lastFailureKind = kind;
                  });
                  if (!applicationStateStore.get().reportedFailures.includes(kind)) {
                    updateApplicationState((state) => ({
                      ...state,
                      reportedFailures: [...state.reportedFailures, kind],
                    }));
                    notifyBestEffort(
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
              productionController.replaceChild(
                acquire.pipe(
                  Effect.onInterrupt(() =>
                    nextRuntime
                      ? nextRuntime.dispose().pipe(
                          Effect.andThen(
                            Effect.sync(() => {
                              if (runtime === nextRuntime) runtime = undefined;
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
        runSessionEffect(startRuntimeEffect(ctx, restoration, allowDisabled));

      const runWithExplicitRuntimeEffect = <T>(
        ctx: ExtensionContext,
        action: () => T,
      ): Effect.Effect<T | undefined> =>
        Effect.suspend(() => {
          const owner = ++explicitStartSequence;
          const expectedCancellationEpoch = applicationStateStore.get().cancellationEpoch;
          pendingExplicitStart = owner;
          return (
            isStarted()
              ? Effect.succeed(applicationStateStore.get().epoch)
              : startRuntimeEffect(ctx, "preserve-live", true)
          ).pipe(
            Effect.map((runtimeEpoch) => {
              if (
                pendingExplicitStart !== owner ||
                runtimeEpoch === undefined ||
                runtimeEpoch !== applicationStateStore.get().epoch ||
                applicationStateStore.get().cancellationEpoch !== expectedCancellationEpoch
              ) {
                if (pendingExplicitStart === owner) pendingExplicitStart = undefined;
                return undefined;
              }
              pendingExplicitStart = undefined;
              return action();
            }),
          );
        });
      const persistLedger = (anchor: string | null, ctx: ExtensionContext): void => {
        if (!anchor || typeof pi.appendEntry !== "function") return;
        const route = applicationStateStore.get().routing;
        try {
          pi.appendEntry(
            ADVISOR_CHECKPOINT_ENTRY_TYPE,
            createCheckpointLedger({
              fingerprint: fingerprint(ctx),
              anchorId: anchor,
              reviewSummary: latestDurableSummary,
              cancellationLatched: route.cancellationLatched,
              completedPrimaryTurns: route.completedPrimaryTurns,
              immunityUntilCompletedTurn: route.immunityUntilCompletedTurn,
              interventionBudget: applicationStateStore.get().pendingPersistentRecovery
                ? {
                    ...applicationStateStore.get().pendingPersistentRecovery!.budgetBefore,
                    correctionUsed: true,
                  }
                : applicationStateStore.get().interventionBudget,
              findingLifecycle: applicationStateStore.get().findingLifecycle.records,
              emissionHashes: exportAdvisorEmissionRecords(
                applicationStateStore.get().emissionGuard,
              ).filter(
                (record) =>
                  !applicationStateStore.get().pendingPersistentRecovery ||
                  !record.endsWith(
                    `:${applicationStateStore.get().pendingPersistentRecovery!.emission.hash}`,
                  ),
              ),
            }),
          );
        } catch {
          // Parent persistence is fail-open and cannot own runtime cleanup.
        }
      };

      const persistCurrentLedger = (ctx: ExtensionContext): void => {
        persistLedger(parentAnchor(ctx), ctx);
      };

      const deliver = (
        checkpoint: AdvisorCheckpoint,
        phase: ReviewPhase,
        source: ReviewSource,
        ctx: ExtensionContext,
        scope: string,
        expectedCancellationEpoch: number,
        trajectoryId?: number,
      ): AdvisorRoute => {
        const discardAtDeliveryBoundary = (): AdvisorRoute => {
          mutateMetrics((next) => {
            next.discarded += 1;
            if (source !== "automatic-catch-up") next.outcomes.discarded += 1;
            next.lastAction = "discarded";
          });
          return "silent";
        };
        if (
          ctx.signal?.aborted ||
          expectedCancellationEpoch !== applicationStateStore.get().cancellationEpoch
        ) {
          return discardAtDeliveryBoundary();
        }
        const review: AdvisorReview = {
          verdict: checkpoint.verdict,
          summary: checkpoint.summary,
          suggestions: checkpoint.suggestions ?? [],
          findings: checkpoint.findings,
        };
        const suppress = (lastAction: "suppressed" | "pass" = "suppressed"): "silent" => {
          mutateMetrics((next) => {
            next.outcomes.suppressed += 1;
            next.lastAction = lastAction;
          });
          return "silent";
        };
        if (review.verdict === "suggest") {
          mutateMetrics((next) => {
            next.suggest = incrementBounded(next.suggest);
          });
          if (
            phase !== "progress" ||
            source === "automatic-catch-up" ||
            source === "last" ||
            source === "verify"
          ) {
            return suppress();
          }
          const suggestion = selectAdvisorPerspective(
            applicationStateStore.get().perspectiveBudget,
            review.suggestions ?? [],
          );
          if (!suggestion) return suppress();
          if (
            ctx.signal?.aborted ||
            expectedCancellationEpoch !== applicationStateStore.get().cancellationEpoch
          ) {
            return discardAtDeliveryBoundary();
          }
          const perspectiveReview: AdvisorReview = {
            verdict: "suggest",
            summary: review.summary,
            suggestions: [suggestion],
            findings: [],
          };
          updateApplicationState((state) => ({
            ...state,
            perspectiveBudget: commitAdvisorPerspective(state.perspectiveBudget, suggestion),
          }));
          sendAdvisorPerspective(pi, currentConfig(), perspectiveReview);
          mutateMetrics((next) => {
            next.outcomes.perspective += 1;
            next.perspectivesDelivered = incrementBounded(next.perspectivesDelivered);
            next.lastAction = "perspective";
          });
          ingest({
            type: "advisor_intervention",
            findingIds: [],
            action: "perspective",
            requestSequence: applicationStateStore.get().requestSequence,
          });
          return "push-direct";
        }
        if (review.verdict === "pass") {
          if (phase === "final") {
            updateApplicationState((state) => ({
              ...state,
              findingLifecycle: reconcileAdvisorFindings(state.findingLifecycle, [], {
                scope,
                completedTurn: state.routing.completedPrimaryTurns,
                complete: true,
              }).state,
            }));
          }
          mutateMetrics((next) => {
            next.pass += 1;
            if (source !== "automatic-catch-up") next.outcomes.pass += 1;
            next.lastAction = "pass";
          });
          return "silent";
        }
        // Tool-calling turn boundaries keep the persistent Advisor caught up, but
        // they are not completed responses and must never emit "unfinished work"
        // critiques. Explicit trajectory checkpoints remain independently routable.
        if (source === "automatic-catch-up") {
          mutateMetrics((next) => {
            next.suppressedFindings = (next.suppressedFindings ?? 0) + review.findings.length;
            next.lastAction = "suppressed";
          });
          return "silent";
        }
        mutateMetrics((next) => {
          next.outcomes.findings += 1;
        });
        const gated = gateAdvisorFindings(review.findings);
        mutateMetrics((next) => {
          next.suppressedFindings = (next.suppressedFindings ?? 0) + gated.suppressed;
        });
        const lifecycle = reconcileAdvisorFindings(
          applicationStateStore.get().findingLifecycle,
          gated.actionable,
          {
            scope,
            completedTurn: applicationStateStore.get().routing.completedPrimaryTurns,
            complete: phase === "final",
          },
        );
        const filtered = filterAdvisorFindingsWithRollback(
          applicationStateStore.get().findingDedupe,
          lifecycle.findings.filter((finding) => finding.status === "open"),
          scope,
        );
        updateApplicationState((state) => ({
          ...state,
          findingLifecycle: lifecycle.state,
          findingDedupe: filtered.state,
        }));
        mutateMetrics((next) => {
          next.suppressedFindings = (next.suppressedFindings ?? 0) + filtered.suppressed;
        });
        if (filtered.findings.length === 0) return suppress();
        const filteredReview = { ...review, findings: filtered.findings };
        const rollbackUndelivered = (emission?: { rollback: AdvisorEmissionRollback }): void => {
          updateApplicationState((state) => ({
            ...state,
            findingDedupe: rollbackAdvisorFindingDedupe(state.findingDedupe, filtered.rollback),
            emissionGuard: emission
              ? rollbackAdvisorEmission(state.emissionGuard, emission.rollback)
              : state.emissionGuard,
          }));
        };
        const emissionResult = evaluateAdvisorEmission(
          applicationStateStore.get().emissionGuard,
          checkpoint.checkpointId,
          filteredReview,
        );
        updateApplicationState((state) => ({ ...state, emissionGuard: emissionResult.state }));
        const emission = emissionResult.decision;
        if (!emission.accepted) {
          rollbackUndelivered();
          return suppress(emission.reason === "pass" ? "pass" : "suppressed");
        }
        mutateMetrics((next) => {
          next.revise += 1;
        });
        const severity = highestAdvisorSeverity(filteredReview);
        if (!severity) {
          rollbackUndelivered(emission);
          return "silent";
        }
        const currentState = applicationStateStore.get();
        const trajectory =
          trajectoryId !== undefined && currentState.activeTrajectory?.id === trajectoryId
            ? currentState.activeTrajectory
            : undefined;
        const aborting = Boolean(
          (currentState.abortInProgress &&
            currentState.abortInProgress.epoch === currentState.epoch &&
            currentState.abortInProgress.parentTurnId === currentState.parentTurnId &&
            currentState.abortInProgress.cancellationEpoch === currentState.cancellationEpoch) ||
          (currentState.pendingPersistentRecovery &&
            currentState.pendingPersistentRecovery.epoch === currentState.epoch &&
            currentState.pendingPersistentRecovery.parentTurnId === currentState.parentTurnId &&
            currentState.pendingPersistentRecovery.cancellationEpoch ===
              currentState.cancellationEpoch),
        );
        const historicalManual = source === "last" || source === "verify";
        const explicitManual = historicalManual || source === "next";
        const budgeted = !explicitManual;
        if (
          budgeted &&
          !canDeliverAdvisorIntervention(applicationStateStore.get().interventionBudget, severity)
        ) {
          rollbackUndelivered(emission);
          return suppress();
        }
        let route = explicitManual
          ? severity === "nit"
            ? "silent"
            : "push-direct"
          : routeAdvisorFinding({
              severity,
              policy: currentConfig().reviewPolicy,
              parentState: aborting
                ? "aborting"
                : ctx.isIdle()
                  ? phase === "final"
                    ? "final"
                    : "idle"
                  : "active",
              immunityActive: isAdvisorImmunityActive(applicationStateStore.get().routing),
              cancellationLatched: applicationStateStore.get().routing.cancellationLatched,
              sameTurnStrongSignal:
                severity === "blocker" &&
                Boolean(
                  trajectory?.loopConfirmed &&
                  trajectory.generation === applicationStateStore.get().parentTurnId,
                ),
              abortSafe: Boolean(
                trajectory?.abortAllowed && advisorActiveToolCount(trajectory.toolDetector) === 0,
              ),
            });
        const correctionRoute =
          route === "steer-live" || route === "trigger-correction" || route === "abort-recover";
        if (
          budgeted &&
          correctionRoute &&
          !canCorrectAdvisorIntervention(applicationStateStore.get().interventionBudget)
        )
          route = "push-direct";
        if (budgeted && route === "push-direct" && ctx.isIdle()) route = "silent";

        // Cancellation is synchronous and wins over a provider completion queued in
        // the same tick. Recheck at the exact delivery boundary before every send path.
        if (
          ctx.signal?.aborted ||
          expectedCancellationEpoch !== applicationStateStore.get().cancellationEpoch
        ) {
          rollbackUndelivered(emission);
          return discardAtDeliveryBoundary();
        }
        const findingIds = filteredReview.findings.flatMap((finding) =>
          finding.id ? [finding.id] : [],
        );
        const recordDelivery = (
          correction: boolean,
          outcome: "advice" | "guidance" | "revision",
        ): AdvisorReview => {
          updateApplicationState((state) => ({
            ...state,
            findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, findingIds),
            interventionBudget: budgeted
              ? commitAdvisorIntervention(state.interventionBudget, severity, correction)
              : state.interventionBudget,
          }));
          recordReceipt(findingIds);
          ingest({
            type: "advisor_intervention",
            findingIds,
            action: outcome,
            requestSequence: applicationStateStore.get().requestSequence,
          });
          mutateMetrics((next) => {
            next.outcomes[outcome] += 1;
            next.interventionsDelivered = (next.interventionsDelivered ?? 0) + 1;
          });
          return reviewWithAcknowledgedFindings(filteredReview, findingIds);
        };
        const pushAdvice = (): void => {
          sendAdvisorAdvice(pi, currentConfig(), recordDelivery(false, "advice"));
        };
        if (route === "silent") {
          rollbackUndelivered(emission);
          suppress();
        } else if (route === "push-direct") {
          pushAdvice();
          mutateMetrics((next) => {
            next.lastAction = "advice";
          });
        } else if (route === "steer-live" || route === "trigger-correction") {
          const outcome = phase === "progress" ? "guidance" : "revision";
          sendCorrection(
            pi,
            currentConfig(),
            recordDelivery(true, outcome),
            phase,
            route === "trigger-correction",
            false,
          );
          updateApplicationState((state) => ({
            ...state,
            routing: armAdvisorInterruption(state.routing),
          }));
          mutateMetrics((next) => {
            next.lastAction = outcome;
          });
        } else {
          if (!trajectory || trajectoryId === undefined) {
            pushAdvice();
            mutateMetrics((next) => {
              next.lastAction = "advice";
            });
            return "push-direct";
          }
          const budgetBefore = applicationStateStore.get().interventionBudget;
          if (budgeted)
            updateApplicationState((state) => ({
              ...state,
              interventionBudget: commitAdvisorIntervention(
                state.interventionBudget,
                severity,
                true,
              ),
            }));
          updateApplicationState((state) => ({
            ...state,
            pendingPersistentRecovery: {
              review: filteredReview,
              config: { ...currentConfig() },
              phase,
              epoch: state.epoch,
              parentTurnId: state.parentTurnId,
              configRevision,
              cancellationEpoch: state.cancellationEpoch,
              recovering: true,
              findingIds,
              budgetBefore,
              dedupeRollback: filtered.rollback,
              emission: {
                checkpointId: checkpoint.checkpointId,
                hash: emission.hash,
                rollback: emission.rollback,
              },
            },
            abortInProgress: {
              epoch: state.epoch,
              parentTurnId: state.parentTurnId,
              turnIndex: trajectory.turnIndex,
              trajectoryId,
              cancellationEpoch: state.cancellationEpoch,
            },
          }));
          mutateMetrics((next) => {
            next.lastAction = "recovery";
          });
          ctx.abort();
        }
        return route;
      };

      const requestCheckpoint = (options: {
        ctx: ExtensionContext;
        focus: AdvisorReviewFocus;
        phase: ReviewPhase;
        source: ReviewSource;
        requiresEnabled: boolean;
        trajectoryId?: number;
        abortOnBlocker?: boolean;
      }): AdvisorCheckpointHandle | undefined => {
        if (
          (!queue || !isStarted()) &&
          (!currentConfig().enabled || !currentConfig().configured || isPaused())
        ) {
          return undefined;
        }
        let validForDelivery = true;
        let requestEpoch = applicationStateStore.get().epoch;
        let requestCancellationEpoch = applicationStateStore.get().cancellationEpoch;
        let activeQueue: AdvisorReviewQueue | undefined;
        let activeCheckpointId: string | undefined;
        const ledgerScope = lifecycleScope(options.ctx);
        const startedAt = parentExecutor ? advisorNow(parentExecutor) : 0;
        let durationRecorded = false;
        let outcomeRecorded = false;
        const finishReviewDuration = () => {
          if (durationRecorded) return;
          durationRecorded = true;
          updateApplicationState((state) => ({
            ...state,
            metrics: recordReviewDuration(state.metrics, startedAt),
          }));
        };
        const discardRequest = (): CheckpointSettlement => {
          if (!outcomeRecorded) {
            outcomeRecorded = true;
            mutateMetrics((next) => {
              next.discarded += 1;
              if (options.source !== "automatic-catch-up") next.outcomes.discarded += 1;
            });
          }
          return "discarded";
        };
        const checkpointSettlement = Effect.gen(function* () {
          const cursorMismatch =
            !runtimeCursor ||
            runtimeCursor.fingerprint !== fingerprint(options.ctx) ||
            !branchContains(options.ctx, runtimeCursor.anchor);
          if (cursorMismatch) {
            // One bounded restart remains part of this same checkpoint settlement,
            // so turn_end's hard catch-up barrier covers both re-seed and review.
            const restartEpoch = yield* startRuntimeEffect(
              options.ctx,
              "restore-branch",
              !options.requiresEnabled,
            );
            if (restartEpoch === undefined || restartEpoch !== applicationStateStore.get().epoch)
              return "discarded";
          }
          if (!validForDelivery || !queue || !isStarted() || !runtimeCursor) return "discarded";
          if (
            options.trajectoryId !== undefined &&
            applicationStateStore.get().activeTrajectory?.id !== options.trajectoryId
          )
            return "discarded";

          activeQueue = queue;
          requestEpoch = applicationStateStore.get().epoch;
          requestCancellationEpoch = applicationStateStore.get().cancellationEpoch;
          const requestParentTurnId = applicationStateStore.get().parentTurnId;
          const requestConfigRevision = configRevision;
          const anchor = parentAnchor(options.ctx);
          const id = `advisor-${requestEpoch}-${++checkpointId}`;
          activeCheckpointId = id;
          mutateMetrics((next) => {
            next.attempted += 1;
          });
          let checkpoint = yield* activeQueue
            .checkpointEffect({
              checkpointId: id,
              focus: options.focus,
              parentTurnId: requestParentTurnId,
            })
            .pipe(Effect.mapError(extensionError("checkpoint")));
          const requestIsCurrent = () =>
            validForDelivery &&
            requestEpoch === applicationStateStore.get().epoch &&
            requestCancellationEpoch === applicationStateStore.get().cancellationEpoch &&
            requestParentTurnId === applicationStateStore.get().parentTurnId &&
            requestConfigRevision === configRevision &&
            !options.ctx.signal?.aborted &&
            (!options.requiresEnabled ||
              (currentConfig().enabled && !isPaused() && currentConfig().configured)) &&
            !options.ctx.hasPendingMessages() &&
            branchContains(options.ctx, anchor) &&
            (options.trajectoryId === undefined ||
              applicationStateStore.get().activeTrajectory?.id === options.trajectoryId);
          if (!requestIsCurrent()) return discardRequest();
          const verifyBlocker =
            options.source !== "automatic-catch-up" &&
            options.source !== "last" &&
            options.source !== "verify" &&
            currentConfig().reviewPolicy !== "advisory" &&
            checkpoint.findings.some(isVerificationCandidate);
          if (verifyBlocker) {
            mutateMetrics((next) => {
              next.blockerVerificationAttempts = (next.blockerVerificationAttempts ?? 0) + 1;
            });
            const verificationId = `advisor-${requestEpoch}-${++checkpointId}`;
            activeCheckpointId = verificationId;
            const verification = yield* activeQueue
              .checkpointEffect({
                checkpointId: verificationId,
                focus: "blocker-verification",
                parentTurnId: requestParentTurnId,
                verificationReview: checkpoint,
              })
              .pipe(Effect.mapError(extensionError("verification checkpoint")));
            if (!requestIsCurrent()) return discardRequest();
            const proposedBlockers = verificationFingerprints(checkpoint.findings);
            checkpoint = applyBlockerVerification(checkpoint, verification);
            const retainedBlockers = verificationFingerprints(checkpoint.findings);
            mutateMetrics((next) => {
              next.blockersVerified = (next.blockersVerified ?? 0) + retainedBlockers.size;
              next.blockersRejected =
                (next.blockersRejected ?? 0) +
                Math.max(0, proposedBlockers.size - retainedBlockers.size);
            });
          }
          finishReviewDuration();
          if (
            !validForDelivery ||
            requestEpoch !== applicationStateStore.get().epoch ||
            requestCancellationEpoch !== applicationStateStore.get().cancellationEpoch ||
            requestParentTurnId !== applicationStateStore.get().parentTurnId ||
            requestConfigRevision !== configRevision ||
            options.ctx.signal?.aborted ||
            (options.requiresEnabled &&
              (!currentConfig().enabled || isPaused() || !currentConfig().configured)) ||
            options.ctx.hasPendingMessages() ||
            !branchContains(options.ctx, anchor)
          ) {
            mutateMetrics((next) => {
              next.lastAction = "discarded";
            });
            return discardRequest();
          }
          if (
            options.trajectoryId !== undefined &&
            applicationStateStore.get().activeTrajectory?.id !== options.trajectoryId
          ) {
            mutateMetrics((next) => {
              next.lastAction = "discarded";
            });
            return discardRequest();
          }

          if (options.source !== "automatic-catch-up") {
            latestStateSummary = checkpoint.stateSummary;
            latestDurableSummary = summarizeAdvisorReview(checkpoint);
          }
          deliver(
            checkpoint,
            options.phase,
            options.source,
            options.ctx,
            ledgerScope,
            requestCancellationEpoch,
            options.abortOnBlocker ? options.trajectoryId : undefined,
          );
          runtimeCursor = { anchor, fingerprint: fingerprint(options.ctx) };
          persistLedger(anchor, options.ctx);
          outcomeRecorded = true;
          return "completed" as const;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              finishReviewDuration();
              if (requestEpoch !== applicationStateStore.get().epoch || !validForDelivery)
                return discardRequest();
              outcomeRecorded = true;
              const kind = classifyFailure(error);
              mutateMetrics((next) => {
                next.failure += 1;
                if (options.source !== "automatic-catch-up") next.outcomes.failures += 1;
                next.lastAction = "failure";
                next.lastFailureKind = kind;
              });
              const failureDetails = {
                contextChars: activeQueue?.backlog ?? 0,
                durationMs: applicationStateStore.get().metrics.latestDurationMs ?? 0,
                error,
                ...(currentConfig().model ? { model: currentConfig().model } : {}),
                ...(currentConfig().provider ? { provider: currentConfig().provider } : {}),
                timeoutMs: currentConfig().timeoutMs,
              };
              yield* Effect.forkIn(
                failureLogger.log(currentConfig().configPath, failureDetails),
                applicationScope,
              );
              if (!applicationStateStore.get().reportedFailures.includes(kind)) {
                updateApplicationState((state) => ({
                  ...state,
                  reportedFailures: [...state.reportedFailures, kind],
                }));
                notifyBestEffort(
                  options.ctx,
                  `Advisor ${kind} failure; keeping the primary response. See /advisor status --verbose.`,
                  "warning",
                );
              }
              if (kind === "authentication") void stopRuntime();
              return "failed" as const;
            }),
          ),
          Effect.withSpan("pi-advisor.parent.checkpoint"),
        );
        const invalidate = () => {
          validForDelivery = false;
        };
        const cancel = Effect.suspend(() => {
          const targetQueue = activeQueue;
          const targetId = activeCheckpointId;
          return targetQueue && targetId
            ? targetQueue.cancelCheckpointEffect(targetId)
            : Effect.void;
        });
        const finalizeCancellation = () => {
          finishReviewDuration();
          discardRequest();
        };
        const orchestrated = checkpointOrchestrator.start(checkpointSettlement, {
          invalidate,
          finalizeCancellation,
          cancelActive: cancel,
        });
        return {
          invalidate: orchestrated.invalidate,
          cancel: orchestrated.cancel,
          cancelEffect: orchestrated.cancelEffect,
          settlement: orchestrated.settlement.pipe(
            Effect.map(
              Exit.match({
                onFailure: () => "failed" as const,
                onSuccess: (value) => value,
              }),
            ),
          ),
        };
      };

      const awaitCatchUpEffectOwned = (
        handle: AdvisorCheckpointHandle,
        ctx: ExtensionContext,
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          mutateMetrics((next) => {
            next.catchUpWaits = incrementBounded(next.catchUpWaits);
            next.activeCatchUpWaits = incrementBounded(next.activeCatchUpWaits);
          });
          const signal = ctx.signal;
          let timeoutRecorded = false;
          const recordTimeout = () => {
            if (timeoutRecorded) return;
            timeoutRecorded = true;
            mutateMetrics((next) => {
              next.catchUpTimeouts = incrementBounded(next.catchUpTimeouts);
            });
          };
          const cancellation = signal
            ? Effect.callback<"cancelled">((resume) => {
                let recorded = false;
                const onAbort = () => {
                  if (recorded) return;
                  recorded = true;
                  handle.invalidate();
                  advanceDomainCounter("cancellationEpoch");
                  latchCancellation();
                  clearPendingRecovery();
                  clearPendingReceipt();
                  persistCurrentLedger(ctx);
                  mutateMetrics((next) => {
                    next.catchUpCancellations = incrementBounded(next.catchUpCancellations);
                  });
                  resume(handle.cancelEffect.pipe(Effect.as("cancelled" as const)));
                };
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
                return Effect.sync(() => signal.removeEventListener("abort", onAbort));
              })
            : Effect.never;
          return awaitAdvisorCatchUpEffect(
            handle.settlement,
            catchUpTimeoutMs,
            cancellation,
            Effect.sync(recordTimeout).pipe(Effect.andThen(handle.cancelEffect)),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome === "timeout") {
                  recordTimeout();
                } else if (outcome === "failed" && !timeoutRecorded) {
                  mutateMetrics((next) => {
                    next.catchUpFailures = incrementBounded(next.catchUpFailures);
                  });
                }
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                mutateMetrics((next) => {
                  next.activeCatchUpWaits = Math.max(0, (next.activeCatchUpWaits ?? 1) - 1);
                });
              }),
            ),
            Effect.asVoid,
          );
        });
      const awaitCatchUp = (
        handle: AdvisorCheckpointHandle,
        ctx: ExtensionContext,
      ): Promise<void> => runSessionEffect(awaitCatchUpEffectOwned(handle, ctx));

      const ingest = (input: Parameters<AdvisorReviewQueue["ingest"]>[1]): void => {
        try {
          queue?.ingest(applicationStateStore.get().parentTurnId, input);
        } catch {
          // Parent streaming and tool events always remain fail-open.
        }
      };

      const cancelEffect = (
        ctx: Parameters<AdvisorCommandActions["cancel"]>[0],
      ): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const hadRequestedReview = applicationStateStore.get().reviewNext;
          const hadExplicitStart = pendingExplicitStart !== undefined;
          const hadRecovery = Boolean(applicationStateStore.get().pendingPersistentRecovery);
          updateApplicationState((state) => ({ ...state, reviewNext: false }));
          pendingExplicitStart = undefined;
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
              queue &&
              (queue.pendingCheckpoints > 0 ||
                queue.backlog > 0 ||
                queue.processedThrough < queue.sequence),
            );
          return checkpointOrchestrator
            .cancelAll()
            .pipe(Effect.andThen(startRuntimeEffect(ctx)), Effect.as(hadWork));
        });

      const commandActions: AdvisorCommandActions = {
        cancel: (ctx) => runSessionEffect(cancelEffect(ctx)),
        pause: (ctx) => {
          updateApplicationState((state) => ({ ...state, paused: true, reviewNext: false }));
          pendingExplicitStart = undefined;
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
          const candidate = lastCandidate;
          if (!candidate) return runSessionEffect(Effect.succeed("unavailable" as const));
          return runSessionEffect(
            runWithExplicitRuntimeEffect(ctx, () => {
              if (lastCandidate !== candidate) return undefined;
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

      registerAdvisorCommands(
        capturingPi,
        {
          get: () => projection.getSnapshot().config,
          getMetrics: () => projection.getSnapshot().metrics,
          persist: (patch, path) => {
            const executor = executorForSession();
            return executor
              ? executor.run(configRepository.patch(patch, path))
              : Promise.reject(
                  new AdvisorExtensionError({
                    operation: "config persistence",
                    message: "Advisor session runtime is not active.",
                  }),
                );
          },
          update: (next) =>
            runSessionEffect(
              Effect.gen(function* () {
                const enabledChanged = currentConfig().enabled !== next.enabled;
                const disabling = currentConfig().enabled && !next.enabled;
                updateApplicationState((state) => ({
                  ...state,
                  config: next,
                  paused: enabledChanged ? false : state.paused,
                }));
                configRevision += 1;
                clearPendingRecovery();
                resetRequestDomain(true);
                latestStateSummary = "";
                latestDurableSummary = summarizeAdvisorReview();
                pendingExplicitStart = undefined;
                if (disabling) latchCancellation();
                advanceDomainCounter("cancellationEpoch");
                if (activeContext) persistCurrentLedger(activeContext);
                yield* publishControllerSnapshot();
                if (activeContext) void startRuntime(activeContext);
              }),
            ),
        },
        commandActions,
        (effect) => runSessionEffect(effect),
      );

      const sessionInitializeEffect = (ctx: ExtensionContext) =>
        Effect.gen(function* () {
          ++parentGeneration;
          advanceDomainCounter("epoch");
          advanceDomainCounter("cancellationEpoch");
          pendingExplicitStart = undefined;
          yield* checkpointOrchestrator.cancelAll();
          removeHostCancellation?.();
          removeHostCancellation = undefined;
          const latchHostCancellation = () => {
            latchCancellation();
            clearPendingRecovery();
            clearPendingReceipt();
            advanceDomainCounter("cancellationEpoch");
            persistCurrentLedger(ctx);
          };
          ctx.signal?.addEventListener("abort", latchHostCancellation, { once: true });
          removeHostCancellation = () =>
            ctx.signal?.removeEventListener("abort", latchHostCancellation);
          if (ctx.signal?.aborted) latchHostCancellation();
          activeContext = ctx;
          const configPath = currentConfig().configPath || getAdvisorConfigPath();
          const configEffect = configRepository
            .load(configPath)
            .pipe(Effect.mapError(extensionError("config load")));
          yield* stopRuntimeUnlockedEffect();
          const loadedConfig = yield* configEffect;
          configRevision += 1;
          updateApplicationState(() => initialAdvisorApplicationState(loadedConfig));
          childStartedOnce = false;
          instructions = yield* loadAdvisorInstructionsEffect(
            currentConfig().configPath,
            ctx.cwd,
            ctx.isProjectTrusted(),
          ).pipe(Effect.mapError(extensionError("instruction load")));
          updateApplicationState((state) => ({
            ...state,
            paused: false,
            reviewNext: false,
            guidancePaths: [...instructions.paths],
            hasLastCandidate: false,
          }));
          pendingExplicitStart = undefined;
          lastCandidate = undefined;
          setDomainCounter("parentTurnId", 0);
          checkpointId = 0;
          advanceDomainCounter("cancellationEpoch");
          resetRequestDomain(true);
          setDomainCounter("requestSequence", 0);
          updateApplicationState((state) => ({
            ...state,
            routing: emptyAdvisorRoutingState(),
          }));
          latestStateSummary = "";
          latestDurableSummary = summarizeAdvisorReview();
          updateApplicationState((state) => ({
            ...state,
            reportedFailures: [],
            reportedDiagnostics: [],
          }));
          yield* publishControllerSnapshot();
          if (!currentConfig().configured)
            warnIfSetupRequired(ctx, currentConfig(), () => undefined, notifyBestEffort);
          yield* startRuntimeEffect(ctx, "restore-branch");
        });
      const sessionShutdownEffect = () =>
        Effect.sync(() => {
          ++parentGeneration;
          advanceDomainCounter("epoch");
          pendingExplicitStart = undefined;
          activeContext = undefined;
          removeHostCancellation?.();
          removeHostCancellation = undefined;
        }).pipe(
          Effect.andThen(checkpointOrchestrator.cancelAll()),
          Effect.andThen(stopRuntimeEffect()),
        );
      const compactEffect = (ctx: ExtensionContext) =>
        Effect.sync(() => {
          ingest({ type: "compaction", marker: "Parent context was compacted." });
          pendingExplicitStart = undefined;
        }).pipe(Effect.andThen(startRuntimeEffect(ctx)), Effect.asVoid);
      const treeEffect = (ctx: ExtensionContext) =>
        Effect.sync(() => {
          ingest({ type: "tree", marker: "Parent active branch changed." });
          pendingExplicitStart = undefined;
          lastCandidate = undefined;
          updateApplicationState((state) => ({ ...state, hasLastCandidate: false }));
          resetRequestDomain(true);
        }).pipe(Effect.andThen(startRuntimeEffect(ctx, "restore-branch")), Effect.asVoid);

      capturingPi.on("session_start", (_event, ctx) =>
        runSessionEffect(sessionInitializeEffect(ctx)),
      );
      capturingPi.on("session_shutdown", () => runSessionEffect(sessionShutdownEffect()));
      capturingPi.on("session_compact", (_event, ctx) => runSessionEffect(compactEffect(ctx)));
      capturingPi.on("session_tree", (_event, ctx) => runSessionEffect(treeEffect(ctx)));

      capturingPi.on("message_end", (event, ctx) => {
        if (!isGenuineUserMessage(event.message)) return;
        clearPersistentTrajectory();
        clearPendingRecovery();
        clearPendingReceipt();
        advanceDomainCounter("requestSequence");
        resetRequestDomain(false);
        advanceDomainCounter("cancellationEpoch");
        updateApplicationState((state) => ({
          ...state,
          routing: clearAdvisorCancellation(state.routing),
        }));
        persistCurrentLedger(ctx);
        const text = contentText(event.message);
        ingest({ type: "user", text: text || "[user content unavailable]" });
        activeContext = ctx;
      });

      capturingPi.on("turn_start", (event, ctx) => {
        clearPersistentTrajectory();
        clearPendingRecovery();
        const receipt = applicationStateStore.get().pendingReceipt;
        if (
          receipt &&
          receipt.cancellationEpoch === applicationStateStore.get().cancellationEpoch &&
          receipt.requestSequence === applicationStateStore.get().requestSequence
        ) {
          ingest({
            type: "advisor_intervention_receipt",
            findingIds: receipt.ids,
            requestSequence: applicationStateStore.get().requestSequence,
          });
          mutateMetrics((next) => {
            next.interventionsAcknowledged = (next.interventionsAcknowledged ?? 0) + receipt.count;
          });
        }
        clearPendingReceipt();
        advanceDomainCounter("parentTurnId");
        if (!currentConfig().enabled || isPaused() || !currentConfig().configured) return;
        const observation: AdvisorActiveTrajectoryState = {
          abortAllowed: false,
          detector: emptyAdvisorTrajectoryDetector(),
          toolDetector: emptyAdvisorToolTrajectoryDetector(),
          generation: applicationStateStore.get().parentTurnId,
          id: ++trajectorySequence,
          loopConfirmed: false,
          reviewQueued: false,
          text: "",
          thinkingChars: 0,
          turnIndex: event.turnIndex,
        };
        updateApplicationState((state) => ({ ...state, activeTrajectory: observation }));
        activeTrajectoryResource = { id: observation.id, ctx };
        const executor = executorForSession();
        if (!executor) return;
        activeTrajectoryResource.cancelTimer = advisorDelay(executor, LONG_TURN_REVIEW_MS, () => {
          const current = applicationStateStore.get().activeTrajectory;
          if (!current || current.id !== observation.id || current.reviewQueued) return;
          mutateTrajectory(observation.id, (next) => ({ ...next, reviewQueued: true }));
          requestCheckpoint({
            ctx,
            focus: "trajectory",
            phase: "progress",
            source: "automatic-progress",
            requiresEnabled: true,
            trajectoryId: observation.id,
            abortOnBlocker: false,
          });
        });
      });

      capturingPi.on("message_update", (event, _ctx) => {
        const update = event.assistantMessageEvent;
        if (update.type === "text_delta") {
          ingest({ type: "assistant_text_delta", text: update.delta });
        } else if (update.type === "thinking_delta") {
          ingest({ type: "assistant_thinking_delta", text: update.delta });
        }
        const observation = applicationStateStore.get().activeTrajectory;
        if (!observation || observation.reviewQueued) return;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
        const channel = update.type === "thinking_delta" ? "thinking" : "text";
        const trajectoryResult = pushAdvisorTrajectory(observation.detector, channel, update.delta);
        const signal = trajectoryResult.signal;
        const next = mutateTrajectory(observation.id, (current) => ({
          ...current,
          detector: trajectoryResult.state,
          thinkingChars:
            channel === "thinking"
              ? current.thinkingChars + update.delta.length
              : current.thinkingChars,
          text:
            channel === "text"
              ? `${current.text}${update.delta}`.slice(-MAX_TRAJECTORY_EVIDENCE_CHARS)
              : current.text,
          abortAllowed:
            signal !== undefined
              ? advisorActiveToolCount(current.toolDetector) === 0
              : current.loopChannel === "thinking" && channel === "text"
                ? false
                : current.abortAllowed,
          ...(signal
            ? {
                loopChannel: signal.channel,
                loopConfirmed: true,
                loopReason: `${signal.channel} stream ${signal.reason}`,
              }
            : {}),
        }));
        if (!signal || !next) return;
        const currentResource = activeTrajectoryResource;
        if (!currentResource || currentResource.id !== observation.id || next.reviewQueued) return;
        mutateTrajectory(observation.id, (current) => ({ ...current, reviewQueued: true }));
        currentResource.cancelTimer?.();
        delete currentResource.cancelTimer;
        requestCheckpoint({
          ctx: currentResource.ctx,
          focus: "trajectory",
          phase: "progress",
          source: "automatic-progress",
          requiresEnabled: true,
          trajectoryId: observation.id,
          abortOnBlocker: next.abortAllowed,
        });
      });

      capturingPi.on("tool_execution_start", (event, _ctx) => {
        activeToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
        const trajectory = applicationStateStore.get().activeTrajectory;
        if (trajectory) {
          mutateTrajectory(trajectory.id, (current) => ({
            ...current,
            abortAllowed: false,
            toolDetector: startAdvisorToolTrajectory(current.toolDetector, event.toolCallId),
          }));
          if (activeTrajectoryResource?.id === trajectory.id) {
            activeTrajectoryResource.cancelTimer?.();
            delete activeTrajectoryResource.cancelTimer;
          }
        }
        ingest({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: safeObservationJson(event.args),
        });
      });
      capturingPi.on("tool_execution_update", (event, _ctx) => {
        ingest({
          type: "tool_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          update: safeObservationJson(event.partialResult),
        });
      });
      capturingPi.on("tool_execution_end", (event, _ctx) => {
        const call = activeToolCalls.get(event.toolCallId);
        activeToolCalls.delete(event.toolCallId);
        ingest({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: safeObservationJson(event.result),
          isError: event.isError,
        });
        const observation = applicationStateStore.get().activeTrajectory;
        if (!observation) return;
        const terminal = {
          parentTurnId: applicationStateStore.get().parentTurnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: call?.args ?? "[call arguments unavailable]",
          result: event.result,
          isError: event.isError,
        };
        const concreteProgress = isMateriallyNovelAdvisorTerminal(
          observation.toolDetector,
          terminal,
          observation.loopConfirmed,
        );
        const toolResult = endAdvisorToolTrajectory(observation.toolDetector, terminal);
        const signal = toolResult.signal;
        const next = mutateTrajectory(observation.id, (current) => {
          const { loopReason: _loopReason, ...withoutLoopReason } = current;
          return {
            ...(concreteProgress ? withoutLoopReason : current),
            toolDetector: concreteProgress
              ? markConcreteAdvisorProgress(toolResult.state)
              : toolResult.state,
            loopConfirmed: concreteProgress ? false : signal ? true : current.loopConfirmed,
            ...(signal && !concreteProgress ? { loopReason: signal.reason } : {}),
            abortAllowed: concreteProgress
              ? false
              : signal
                ? signal.abortSafe
                : advisorActiveToolCount(toolResult.state) === 0,
          };
        });
        if (concreteProgress || !signal || !next || next.reviewQueued) return;
        ingest({
          type: "trajectory_signal",
          kind: signal.kind,
          confidence: signal.confidence,
          reason: signal.reason,
          evidence: signal.evidence,
          abortSafe: signal.abortSafe,
        });
        mutateTrajectory(observation.id, (current) => ({ ...current, reviewQueued: true }));
        const currentResource = activeTrajectoryResource;
        if (!currentResource || currentResource.id !== observation.id) return;
        requestCheckpoint({
          ctx: currentResource.ctx,
          focus: "trajectory",
          phase: "progress",
          source: "automatic-progress",
          requiresEnabled: true,
          trajectoryId: observation.id,
          abortOnBlocker: true,
        });
      });

      capturingPi.on("agent_settled", (_event, ctx) => {
        const recovery = applicationStateStore.get().pendingPersistentRecovery;
        if (
          !recovery ||
          recovery.epoch !== applicationStateStore.get().epoch ||
          recovery.parentTurnId !== applicationStateStore.get().parentTurnId ||
          recovery.configRevision !== configRevision ||
          recovery.cancellationEpoch !== applicationStateStore.get().cancellationEpoch ||
          !currentConfig().enabled ||
          isPaused() ||
          !currentConfig().configured ||
          ctx.signal?.aborted ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages()
        ) {
          clearPendingRecovery();
          return;
        }
        updateApplicationState((state) => ({
          ...state,
          pendingPersistentRecovery: undefined,
          abortInProgress: undefined,
          findingLifecycle: acknowledgeAdvisorFindings(state.findingLifecycle, recovery.findingIds),
        }));
        sendTriggeredCorrection(
          pi,
          recovery.config,
          reviewWithAcknowledgedFindings(recovery.review, recovery.findingIds),
          recovery.phase,
          recovery.recovering,
        );
        mutateMetrics((next) => {
          next.outcomes.recovery += 1;
          next.interventionsDelivered = (next.interventionsDelivered ?? 0) + 1;
        });
        recordReceipt(recovery.findingIds);
        ingest({
          type: "advisor_intervention",
          findingIds: recovery.findingIds,
          action: "recovery",
          requestSequence: applicationStateStore.get().requestSequence,
        });
        updateApplicationState((state) => ({
          ...state,
          routing: armAdvisorInterruption(state.routing),
        }));
        persistLedger(parentAnchor(ctx), ctx);
      });

      capturingPi.on("turn_end", (event, ctx) => {
        const trajectory = applicationStateStore.get().activeTrajectory;
        clearPersistentTrajectory();
        const classification = classifyReviewCheckpoint(event);
        const stopReason = assistantStopReason(event.message);
        if (classification.eligible) {
          ingest({
            type: "assistant_final",
            text: classification.candidate,
            toolCalls: assistantToolCalls(event.message),
          });
        }
        ingest({ type: "turn_complete", status: stopReason });
        if (stopReason === "stop")
          updateApplicationState((state) => ({
            ...state,
            routing: completeAdvisorPrimaryTurn(state.routing),
          }));
        if (!classification.eligible) {
          recordSkip(classification.reason === "empty" ? "empty" : "incomplete");
          if (stopReason !== "stop" && trajectory)
            mutateTrajectory(trajectory.id, (current) => ({ ...current, abortAllowed: false }));
          if (stopReason === "aborted") {
            const provenance = applicationStateStore.get().abortInProgress;
            const matchingAdvisorAbort = Boolean(
              provenance &&
              provenance.epoch === applicationStateStore.get().epoch &&
              provenance.parentTurnId === applicationStateStore.get().parentTurnId &&
              provenance.cancellationEpoch === applicationStateStore.get().cancellationEpoch &&
              provenance.turnIndex === event.turnIndex &&
              trajectory?.id === provenance.trajectoryId,
            );
            if (matchingAdvisorAbort) {
              updateApplicationState((state) => ({ ...state, abortInProgress: undefined }));
            } else {
              clearPendingRecovery();
              latchCancellation();
              advanceDomainCounter("cancellationEpoch");
              persistCurrentLedger(ctx);
            }
          }
          return;
        }
        const messages = activeContextMessages(ctx);
        if (classification.phase === "final") {
          lastCandidate = {
            candidate: classification.candidate,
            generation: applicationStateStore.get().parentTurnId,
            messages,
            sessionEpoch: applicationStateStore.get().epoch,
          };
          updateApplicationState((state) => ({ ...state, hasLastCandidate: true }));
        }
        const explicitlyRequested =
          classification.phase === "final" && applicationStateStore.get().reviewNext;
        if (explicitlyRequested) {
          updateApplicationState((state) => ({ ...state, reviewNext: false }));
          return runSessionEffect(
            runWithExplicitRuntimeEffect(ctx, () =>
              requestCheckpoint({
                ctx,
                focus: "standard",
                phase: "final",
                source: "next",
                requiresEnabled: false,
              }),
            ).pipe(
              Effect.flatMap((handle) =>
                handle ? awaitCatchUpEffectOwned(handle, ctx) : Effect.void,
              ),
            ),
          );
        }
        if (!explicitlyRequested && !currentConfig().enabled) {
          recordSkip("disabled");
          return;
        }
        if (!explicitlyRequested && isPaused()) {
          recordSkip("session-paused");
          return;
        }
        if (!currentConfig().configured) {
          recordSkip("unconfigured");
          return;
        }
        const perspectiveCheckpoint =
          classification.phase === "progress" && !perspectiveCheckpointUsed;
        const handle = requestCheckpoint({
          ctx,
          focus:
            classification.phase === "progress"
              ? perspectiveCheckpoint
                ? "perspective"
                : "observation"
              : "standard",
          phase: classification.phase,
          source:
            classification.phase === "progress"
              ? perspectiveCheckpoint
                ? "automatic-perspective"
                : "automatic-catch-up"
              : "automatic-final",
          requiresEnabled: true,
        });
        if (handle && perspectiveCheckpoint) perspectiveCheckpointUsed = true;
        return handle ? awaitCatchUp(handle, ctx) : undefined;
      });

      const invokeEvent = (
        name: string,
        event: never,
        ctx: ExtensionContext,
      ): Effect.Effect<unknown, AdvisorExtensionError> =>
        Effect.suspend(() => {
          const handler = options.eventHandlers.get(name);
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
          const handler = options.commandHandlers.get(name);
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
        sessionInitialize: (_event, ctx) =>
          sessionInitializeEffect(ctx).pipe(Effect.provide(platformContext)),
        sessionShutdown: () => sessionShutdownEffect(),
        event: invokeEvent,
        compact: (_event, ctx) => compactEffect(ctx),
        tree: (_event, ctx) => treeEffect(ctx),
        cancel: cancelEffect,
        command: invokeCommand,
      });
      yield* Effect.addFinalizer(() =>
        stopRuntimeUnlockedEffect().pipe(Effect.andThen(resources.stopChild)),
      );
      return service;
    }),
  );

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  return function registerPersistentAdvisorExtension(pi: ExtensionAPI): void {
    registerAdvisorReviewRenderer(pi);
    const eventHandlers = new Map<string, AdvisorHostEventHandler>();
    const commandHandlers = new Map<string, AdvisorHostCommandHandler>();
    const commandDefinitions = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    let parentSlot!: PiSessionRuntimeSlot<
      ExtensionContext,
      | AdvisorPlatform
      | AdvisorRuntimeService
      | AdvisorReviewQueueService
      | AdvisorController
      | ConfigRepository
      | FailureLogger
      | HostNotifier
      | PiCommandAdapter
    >;
    const sessionExecutor: AdvisorEffectExecutor = {
      run: (effect, signal) => parentSlot.run(effect, signal),
      fork: (effect) => {
        const fiber = parentSlot.fork(effect);
        if (!fiber)
          throw new AdvisorExtensionError({
            operation: "session fork",
            message: "Advisor session runtime is not active.",
          });
        return fiber as Fiber.Fiber<never, never>;
      },
      now: () => performance.now(),
    };
    const repositoryLayer = dependencies.loadConfig
      ? configRepositoryTestLayer(dependencies.loadConfig)
      : configRepositoryLayer;
    const loggerLayer = dependencies.logFailure
      ? failureLoggerTestLayer(dependencies.logFailure)
      : failureLoggerLayer;
    const dependenciesLayer = Layer.mergeAll(
      advisorRuntimeServiceLayer(sessionExecutor),
      advisorReviewQueueServiceLayer,
      PiCommandAdapter.layer,
      repositoryLayer,
      loggerLayer,
      hostNotifierLayer,
    ).pipe(Layer.provideMerge(advisorPlatformLayer));
    const applicationLayer = advisorControllerApplicationLayer({
      pi,
      executor: sessionExecutor,
      dependencies,
      eventHandlers,
      commandHandlers,
      commandDefinitions,
    }).pipe(Layer.provideMerge(dependenciesLayer));
    parentSlot = makePiSessionRuntimeSlot<
      ExtensionContext,
      Layer.Success<typeof applicationLayer>,
      AdvisorExtensionError
    >({
      makeRuntime: () => makePiManagedRuntime(pi, applicationLayer),
      startup: (ctx) =>
        Effect.gen(function* () {
          const controller = yield* AdvisorController;
          yield* controller.sessionInitialize(undefined as never, ctx);
        }),
    });

    const runController = <A, E>(
      operation: (controller: AdvisorControllerShape) => Effect.Effect<A, E>,
    ): Promise<A> => parentSlot.run(Effect.flatMap(AdvisorController, operation));

    for (const name of ["advisor", "advisor-settings", "advisor-status", "advisor-usage"]) {
      pi.registerCommand(name, {
        description: `Advisor ${name.replace("advisor", "").replace("-", " ").trim() || "control"}`,
        getArgumentCompletions: (prefix) =>
          commandDefinitions.get(name)?.getArgumentCompletions?.(prefix) ?? null,
        handler: (args, ctx) => {
          const projected = commandHandlers.get(name);
          if ((name === "advisor-status" || name === "advisor-usage") && projected) {
            return runController((controller) => controller.refreshProjection)
              .catch(() => undefined)
              .then(() => projected(args, ctx))
              .then(
                () => undefined,
                () => undefined,
              );
          }
          return runController((controller) => controller.command(name, args, ctx)).then(
            () => undefined,
            () => undefined,
          );
        },
      });
    }

    pi.on("session_start", (_event, ctx) =>
      parentSlot.start(ctx, ctx.signal).then(() => undefined),
    );
    pi.on("session_shutdown", (event, ctx) =>
      runController((controller) => controller.sessionShutdown(event as never, ctx))
        .catch(() => undefined)
        .then(() => parentSlot.shutdown()),
    );
    pi.on("session_compact", (event, ctx) =>
      runController((controller) => controller.compact(event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("session_tree", (event, ctx) =>
      runController((controller) => controller.tree(event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("message_end", (event, ctx) =>
      runController((controller) => controller.event("message_end", event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("turn_start", (event, ctx) =>
      runController((controller) => controller.event("turn_start", event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("message_update", (event, ctx) =>
      runController((controller) => controller.event("message_update", event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("tool_execution_start", (event, ctx) =>
      runController((controller) =>
        controller.event("tool_execution_start", event as never, ctx),
      ).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("tool_execution_update", (event, ctx) =>
      runController((controller) =>
        controller.event("tool_execution_update", event as never, ctx),
      ).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("tool_execution_end", (event, ctx) =>
      runController((controller) =>
        controller.event("tool_execution_end", event as never, ctx),
      ).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("agent_settled", (event, ctx) =>
      runController((controller) => controller.event("agent_settled", event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
    pi.on("turn_end", (event, ctx) =>
      runController((controller) => controller.event("turn_end", event as never, ctx)).then(
        () => undefined,
        () => undefined,
      ),
    );
  };
}

const advisorRuntimeEffectsFromDriver = (
  driver: AdvisorRuntimeDriver,
): AdvisorRuntimeServiceShape => {
  const modelError = (operation: string) => (error: unknown) =>
    error instanceof AdvisorModelError
      ? error
      : new AdvisorModelError({
          message: error instanceof Error ? error.message : `Advisor ${operation} failed.`,
        });
  return {
    activeToolNames: () => driver.activeToolNames,
    start: (options) =>
      Effect.tryPromise({ try: () => driver.start(options), catch: modelError("child startup") }),
    checkpoint: (request) =>
      Effect.tryPromise({ try: () => driver.checkpoint(request), catch: modelError("checkpoint") }),
    steer: (observations) =>
      Effect.tryPromise({ try: () => driver.steer(observations), catch: modelError("steering") }),
    reprime: (seed, stateSummary) =>
      Effect.tryPromise({
        try: () => driver.reprime(seed, stateSummary),
        catch: modelError("re-prime"),
      }),
    abort: () => Effect.promise(() => driver.abort()),
    dispose: () => Effect.promise(() => driver.dispose()),
  };
};

export const advisorExtension = createAdvisorExtension();

interface CancellationLatch {
  readonly await: Effect.Effect<void>;
  readonly cancel: () => void;
}

const makeCancellationLatch = (): CancellationLatch => {
  let cancelled = false;
  let resume: (() => void) | undefined;
  return {
    await: Effect.callback<void>((complete) => {
      resume = () => complete(Effect.void);
      if (cancelled) resume();
      return Effect.sync(() => {
        resume = undefined;
      });
    }),
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      resume?.();
    },
  };
};

function contentText(message: unknown): string {
  message = snapshotData(message);
  if (!isRecord(message)) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}

function safeObservationJson(value: unknown): string {
  return stringifyRedactedObservation(value).slice(0, 12_000);
}

function assistantStopReason(message: unknown): "stop" | "aborted" | "error" | "length" {
  message = snapshotData(message);
  if (!isRecord(message)) return "error";
  return message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
    ? message.stopReason
    : "stop";
}

function assistantToolCalls(message: unknown): string[] {
  message = snapshotData(message);
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  return message.content.flatMap((part) =>
    isRecord(part) && part.type === "toolCall"
      ? [
          `${typeof part.name === "string" ? part.name : "unknown"} ${safeObservationJson(part.arguments)}`,
        ]
      : [],
  );
}

function applyBlockerVerification(
  initial: AdvisorCheckpoint,
  verification: AdvisorCheckpoint,
): AdvisorCheckpoint {
  const verified = verificationFingerprints(verification.findings);
  const findings = initial.findings.filter(
    (finding) =>
      !isVerificationCandidate(finding) ||
      verified.has(canonicalAdvisorFindingFingerprint(finding.fingerprint ?? "")),
  );
  return {
    ...initial,
    verdict: findings.length > 0 ? "revise" : "pass",
    summary: findings.length > 0 ? initial.summary : verification.summary,
    findings,
  };
}

function isVerificationCandidate(finding: AdvisorFinding): boolean {
  return (
    finding.severity === "blocker" &&
    finding.confidence === "high" &&
    finding.evidenceBasis === "direct"
  );
}

function verificationFingerprints(findings: readonly AdvisorFinding[]): Set<string> {
  return new Set(
    findings.flatMap((finding) =>
      isVerificationCandidate(finding) && finding.fingerprint
        ? [canonicalAdvisorFindingFingerprint(finding.fingerprint)]
        : [],
    ),
  );
}

function reviewWithAcknowledgedFindings(
  review: AdvisorReview,
  findingIds: readonly string[],
): AdvisorReview {
  const acknowledged = new Set(findingIds);
  return {
    ...review,
    findings: review.findings.map((finding) =>
      finding.id && acknowledged.has(finding.id) ? { ...finding, status: "acknowledged" } : finding,
    ),
  };
}

function incrementBounded(value: number | undefined): number {
  return Math.min(Number.MAX_SAFE_INTEGER, (value ?? 0) + 1);
}

function emptySessionMetrics(): AdvisorSessionMetrics {
  return {
    attempted: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    discarded: 0,
    failure: 0,
    inputTokens: 0,
    modelResponses: 0,
    outputTokens: 0,
    outcomes: emptyAdvisorOutcomes(),
    pass: 0,
    revise: 0,
    skippedReviews: {},
    suppressedFindings: 0,
    settledReviews: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    usageByModel: {},
  };
}

function activeContextMessages(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
}

function classifyFailure(error: unknown): string {
  if (error instanceof AdvisorReviewParseError) return "response-format";
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("auth") || message.includes("credential") || message.includes("api key")) {
    return "authentication";
  }
  if (message.includes("timeout") || message.includes("timed out")) return "timeout";
  if (message.includes("unavailable") || message.includes("not configured")) return "model";
  if (message.includes("abort")) return "cancelled";
  return "provider";
}

function sendTriggeredCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
  recovering = false,
): void {
  sendCorrection(pi, config, review, phase, true, recovering);
}

function sendAdvisorAdvice(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  sendAdvisorMessage(pi, config, review, "advice", buildAdvisorAdvice);
}

function sendAdvisorPerspective(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
): void {
  sendAdvisorMessage(pi, config, review, "perspective", buildAdvisorPerspective);
}

function sendCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
  triggerTurn: boolean,
  recovering: boolean,
): void {
  const action = recovering ? "recovery" : phase === "progress" ? "guidance" : "revision";
  sendAdvisorMessage(
    pi,
    config,
    review,
    action,
    (safeReview) =>
      phase === "progress"
        ? buildProgressSteer(safeReview, recovering)
        : buildRevisionSteer(safeReview),
    triggerTurn,
  );
}

function sendAdvisorMessage(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  action: "advice" | "guidance" | "perspective" | "recovery" | "revision",
  content: (review: AdvisorReview) => string,
  triggerTurn = false,
): void {
  if (!config.provider || !config.model) return;
  const safeReview = sanitizeAdvisorReview(review);
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: content(safeReview),
      display: true,
      details: {
        action,
        review: safeReview,
        provider: safeAdvisorLabel(config.provider),
        model: safeAdvisorLabel(config.model),
      },
    },
    triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
  );
}

function warnIfSetupRequired(
  ctx: ExtensionContext,
  config: ResolvedAdvisorConfig,
  markShown: () => void,
  notify: HostNotifierShape["notify"],
): void {
  if (!config.enabled || config.configured) return;
  markShown();
  notify(
    ctx,
    "Advisor review is enabled but no dedicated model is configured. Use /advisor-settings.",
    "warning",
  );
}

function isGenuineUserMessage(message: unknown): boolean {
  const snapshot = snapshotData(message);
  return isRecord(snapshot) && snapshot.role === "user";
}

type CandidateClassification =
  | { eligible: true; candidate: string; phase: ReviewPhase }
  | {
      eligible: false;
      reason: "not-assistant" | "empty" | "incomplete";
    };

function classifyReviewCheckpoint(event: TurnEndEvent): CandidateClassification {
  const message = snapshotData(event.message);
  if (!isRecord(message) || message.role !== "assistant") {
    return { eligible: false, reason: "not-assistant" };
  }
  if (
    message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
  )
    return { eligible: false, reason: "incomplete" };
  if (!Array.isArray(message.content)) return { eligible: false, reason: "empty" };
  const hasToolCall = message.content.some((part) => isRecord(part) && part.type === "toolCall");
  if (hasToolCall) {
    const candidate = assistantCheckpointText(message);
    return candidate
      ? { eligible: true, candidate, phase: "progress" }
      : { eligible: false, reason: "empty" };
  }
  if (message.stopReason !== "stop") return { eligible: false, reason: "incomplete" };
  const candidate = assistantText(message);
  return candidate
    ? { eligible: true, candidate, phase: "final" }
    : { eligible: false, reason: "empty" };
}

function classifyReviewCandidate(event: TurnEndEvent): CandidateClassification {
  const result = classifyReviewCheckpoint(event);
  return result.eligible && result.phase !== "final"
    ? { eligible: false, reason: "incomplete" }
    : result;
}

function isReviewCandidate(event: TurnEndEvent): boolean {
  return classifyReviewCandidate(event).eligible;
}

function assistantCheckpointText(message: unknown): string | undefined {
  message = snapshotData(message);
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const parts = message.content.flatMap((part) => {
    if (!isRecord(part)) return [];
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return [part.text.trim()];
    }
    if (part.type !== "toolCall") return [];
    const name = typeof part.name === "string" && part.name ? part.name : "unknown";
    let args = "";
    try {
      args = part.arguments === undefined ? "" : ` ${stringifyJson(part.arguments)}`;
    } catch {
      args = " [unserializable arguments]";
    }
    return [`[tool call: ${name}${args}]`];
  });
  const text = parts.join("\n").trim();
  return text || undefined;
}

function assistantText(message: unknown): string | undefined {
  message = snapshotData(message);
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();
  return text || undefined;
}

export const _extensionTest = {
  activeContextMessages,
  assistantCheckpointText,
  assistantText,
  classifyFailure,
  classifyReviewCandidate,
  classifyReviewCheckpoint,
  isGenuineUserMessage,
  isReviewCandidate,
};
