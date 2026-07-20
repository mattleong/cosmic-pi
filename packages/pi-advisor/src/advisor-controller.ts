import { stringifyJson } from "./boundary/json.ts";
import { snapshotData } from "./boundary/safe-data.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
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
import { advisorDelay, advisorInterval, advisorNow } from "./boundary/clock.ts";
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
  loadAdvisorConfigEffect,
  normalizeAdvisorConfig,
  writeAdvisorConfigPatchEffect,
  type ResolvedAdvisorConfig,
} from "./config.ts";
import { safeAdvisorLabel } from "./advisor-label.ts";
import { AdvisorFindingDedupe, type AdvisorFindingDedupeRollback } from "./dedupe.ts";
import { gateAdvisorFindings } from "./finding-gates.ts";
import { AdvisorFindingLifecycle } from "./finding-lifecycle.ts";
import { AdvisorPerspectiveBudget } from "./perspective-budget.ts";
import {
  AdvisorInterventionBudget,
  type AdvisorInterventionBudgetSnapshot,
} from "./intervention-budget.ts";
import {
  AdvisorEmissionGuard,
  highestAdvisorSeverity,
  type AdvisorEmissionRollback,
} from "./emission-guard.ts";
import { buildAdvisorContext } from "./context.ts";
import { logAdvisorFailureEffect, logAdvisorFailureAsync } from "./failure-log.ts";
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
import { AdvisorRoutingState, routeAdvisorFinding, type AdvisorRoute } from "./routing.ts";
import { PiCommandAdapter } from "./pi-command-adapter.ts";
import {
  emptyAdvisorOutcomes,
  type AdvisorCommandActions,
  type AdvisorSessionMetrics,
  registerAdvisorCommands,
} from "./settings.ts";
import {
  AdvisorToolTrajectoryDetector,
  AdvisorTrajectoryDetector,
  LONG_TURN_REVIEW_MS,
  MAX_TRAJECTORY_EVIDENCE_CHARS,
} from "./trajectory.ts";

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
    Effect.raceFirst(
      Effect.sleep(timeoutMs).pipe(Effect.andThen(onTimeout), Effect.as("timeout" as const)),
    ),
    Effect.raceFirst(cancellation),
    Effect.withSpan("pi-advisor.catch-up"),
  );

interface AdvisorCheckpointHandle {
  invalidate(): void;
  cancel(): void;
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

interface ActiveTurnObservation {
  abortAllowed: boolean;
  ctx: ExtensionContext;
  detector: AdvisorTrajectoryDetector;
  toolDetector: AdvisorToolTrajectoryDetector;
  generation: number;
  id: number;
  loopChannel?: "thinking" | "text";
  loopConfirmed: boolean;
  loopReason?: string;
  reviewQueued: boolean;
  text: string;
  thinkingChars: number;
  cancelTimer?: () => void;
  turnIndex: number;
}

interface LastCandidate {
  candidate: string;
  generation: number;
  messages: unknown[];
  sessionEpoch: number;
}

export interface AdvisorControllerSnapshot {
  readonly config: ResolvedAdvisorConfig;
  readonly metrics: AdvisorSessionMetrics;
  readonly paused: boolean;
  readonly started: boolean;
}

type AdvisorHostEventHandler = (event: never, ctx: ExtensionContext) => unknown | Promise<unknown>;

type AdvisorHostCommandHandler = (
  args: string,
  ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
) => unknown | Promise<unknown>;

export interface AdvisorControllerShape {
  readonly snapshot: SynchronizedRef.SynchronizedRef<AdvisorControllerSnapshot>;
  readonly publish: (snapshot: AdvisorControllerSnapshot) => Effect.Effect<void>;
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

interface AdvisorOwnedChild {
  readonly value: unknown;
  readonly release: Effect.Effect<void>;
}

export const advisorControllerLayer = Layer.effect(
  AdvisorController,
  Effect.gen(function* () {
    const transitionLock = yield* Semaphore.make(1);
    const snapshot = yield* SynchronizedRef.make<AdvisorControllerSnapshot>({
      config: normalizeAdvisorConfig({}, ""),
      metrics: emptySessionMetrics(),
      paused: false,
      started: false,
    });
    const child = yield* SynchronizedRef.make<AdvisorOwnedChild | undefined>(undefined);
    const stopChild = transitionLock.withPermits(1)(
      Effect.gen(function* () {
        const active = yield* SynchronizedRef.getAndSet(child, undefined);
        if (active) yield* active.release;
      }),
    );
    const unavailable = (operation: string) =>
      Effect.fail(
        new AdvisorExtensionError({
          operation,
          message: "Advisor application controller is not configured.",
        }),
      );
    const service = AdvisorController.of({
      snapshot,
      publish: (next) => SynchronizedRef.set(snapshot, Object.freeze(next)),
      replaceChild: (acquire, release) =>
        transitionLock.withPermits(1)(
          Effect.gen(function* () {
            const active = yield* SynchronizedRef.getAndSet(child, undefined);
            if (active) yield* active.release;
            const next = yield* acquire;
            yield* SynchronizedRef.set(child, {
              value: next,
              release: release(next),
            });
            return next;
          }),
        ),
      stopChild: () => stopChild,
      sessionInitialize: () => unavailable("session initialize"),
      sessionShutdown: () => unavailable("session shutdown"),
      event: (name) => unavailable(name),
      compact: () => unavailable("session compact"),
      tree: () => unavailable("session tree"),
      cancel: () => unavailable("cancel"),
      command: (name) => unavailable(`command ${name}`),
    });
    yield* Effect.addFinalizer(() => stopChild);
    return service;
  }),
);

export interface AdvisorExtensionDependencies {
  loadConfig?: (path?: string) => ResolvedAdvisorConfig | Promise<ResolvedAdvisorConfig>;
  logFailure?: (
    configPath: string,
    details: Parameters<typeof logAdvisorFailureAsync>[1],
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
      const loadConfig = dependencies.loadConfig;
      const logFailure = dependencies.logFailure;
      const createRuntime = dependencies.createRuntime;
      const catchUpTimeoutMs = Math.min(
        ADVISOR_CATCH_UP_TIMEOUT_MS,
        Math.max(1, dependencies.catchUpTimeoutMs ?? ADVISOR_CATCH_UP_TIMEOUT_MS),
      );
      const productionRuntimeService = yield* AdvisorRuntimeService;
      const productionQueueService = yield* AdvisorReviewQueueService;
      const commandAdapter = yield* PiCommandAdapter;
      const platformContext = yield* Effect.context<AdvisorPlatform>();
      const transitionLock = yield* Semaphore.make(1);
      const snapshot = yield* SynchronizedRef.make<AdvisorControllerSnapshot>({
        config: normalizeAdvisorConfig({}, ""),
        metrics: emptySessionMetrics(),
        paused: false,
        started: false,
      });
      const child = yield* SynchronizedRef.make<AdvisorOwnedChild | undefined>(undefined);
      const stopOwnedChild = transitionLock.withPermits(1)(
        Effect.gen(function* () {
          const active = yield* SynchronizedRef.getAndSet(child, undefined);
          if (active) yield* active.release;
        }),
      );
      const productionController = {
        publish: (next: AdvisorControllerSnapshot) =>
          SynchronizedRef.set(snapshot, Object.freeze(next)),
        replaceChild: <A, E, R>(
          acquire: Effect.Effect<A, E, R>,
          release: (value: A) => Effect.Effect<void>,
        ) =>
          transitionLock.withPermits(1)(
            Effect.gen(function* () {
              const active = yield* SynchronizedRef.getAndSet(child, undefined);
              if (active) yield* active.release;
              const next = yield* acquire;
              yield* SynchronizedRef.set(child, { value: next, release: release(next) });
              return next;
            }),
          ),
        stopChild: () => stopOwnedChild,
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
      let config = normalizeAdvisorConfig({}, "");
      const parentExecutor: AdvisorEffectExecutor = options.executor;
      let parentGeneration = 0;
      let removeHostCancellation: (() => void) | undefined;
      let configRevision = 0;
      let epoch = 0;
      let parentTurnId = 0;
      let checkpointId = 0;
      let queue: AdvisorReviewQueue | undefined;
      let runtime: AdvisorRuntimeServiceShape | undefined;
      let runtimeCursor: { anchor: string | null; fingerprint: string } | undefined;
      let activeContext: ExtensionContext | undefined;
      let metrics = emptySessionMetrics();
      const publishControllerSnapshot = (): void => {
        const controller = productionController;
        const executor = parentExecutor;
        if (!controller || !executor) return;
        executor.fork(controller.publish({ config, metrics, paused, started }));
      };
      const activeCheckpointInvalidators = new Set<() => void>();
      const activeCheckpointCancellationFinalizers = new Set<() => void>();
      let instructions: LoadedAdvisorInstructions = { paths: [] };
      let paused = false;
      let reviewNext = false;
      let pendingExplicitStart: number | undefined;
      let explicitStartSequence = 0;
      let lastCandidate: LastCandidate | undefined;
      let started = false;
      let childStartedOnce = false;
      let activeTrajectory: ActiveTurnObservation | undefined;
      let trajectorySequence = 0;
      let pendingPersistentRecovery:
        | {
            review: AdvisorReview;
            config: ResolvedAdvisorConfig;
            phase: ReviewPhase;
            epoch: number;
            parentTurnId: number;
            configRevision: number;
            cancellationEpoch: number;
            recovering: boolean;
            findingIds: string[];
            metrics: AdvisorSessionMetrics;
            budgetBefore: AdvisorInterventionBudgetSnapshot;
            dedupeRollback: AdvisorFindingDedupeRollback;
            emission: { checkpointId: string; hash: string; rollback: AdvisorEmissionRollback };
          }
        | undefined;
      let cancellationEpoch = 0;
      let abortInProgress:
        | {
            epoch: number;
            parentTurnId: number;
            turnIndex: number;
            trajectoryId: number;
            cancellationEpoch: number;
          }
        | undefined;
      const findingDedupe = new AdvisorFindingDedupe();
      const findingLifecycle = new AdvisorFindingLifecycle();
      const perspectiveBudget = new AdvisorPerspectiveBudget();
      const interventionBudget = new AdvisorInterventionBudget();
      let perspectiveCheckpointUsed = false;
      const routingState = new AdvisorRoutingState();
      let requestSequence = 0;
      let pendingInterventionReceipt:
        | { ids: string[]; count: number; cancellationEpoch: number; requestSequence: number }
        | undefined;
      const recordReceipt = (ids: readonly string[]): void => {
        const prior = pendingInterventionReceipt;
        pendingInterventionReceipt = {
          ids:
            prior?.requestSequence === requestSequence
              ? [...new Set([...prior.ids, ...ids])].slice(0, 5)
              : [...ids],
          count: prior?.requestSequence === requestSequence ? prior.count + 1 : 1,
          cancellationEpoch,
          requestSequence,
        };
      };
      const emissionGuard = new AdvisorEmissionGuard();
      const activeToolCalls = new Map<string, { toolName: string; args: unknown }>();
      let latestStateSummary = "";
      let latestDurableSummary: AdvisorDurableReviewSummary = summarizeAdvisorReview();
      const reportedFailures = new Set<string>();
      const reportedDiagnostics = new Set<string>();
      let statusSpinnerContext: ExtensionContext | undefined;
      let statusSpinnerDelay: (() => void) | undefined;
      let statusSpinnerFrame = 0;
      let statusSpinnerOwner: string | undefined;
      let statusSpinnerTimer: (() => void) | undefined;

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

      const notifyBestEffort = (
        ctx: Pick<ExtensionContext, "ui">,
        message: string,
        level: "info" | "warning" | "error",
      ): void => {
        try {
          ctx.ui.notify(message, level);
        } catch {
          // Host UI cannot own lifecycle cleanup.
        }
      };

      const stopStatusSpinner = (): void => {
        try {
          statusSpinnerDelay?.();
          statusSpinnerTimer?.();
        } catch {
          // Fiber interruption is best-effort at the synchronous host boundary.
        }
        statusSpinnerContext = undefined;
        statusSpinnerDelay = undefined;
        statusSpinnerFrame = 0;
        statusSpinnerOwner = undefined;
        statusSpinnerTimer = undefined;
      };

      const setAdvisorStatus = (ctx: ExtensionContext, text?: string): void => {
        stopStatusSpinner();
        try {
          ctx.ui.setStatus(STATUS_KEY, text);
        } catch {
          // Status rendering cannot prevent resource cleanup.
        }
      };

      const renderReviewStatus = (): void => {
        if (!statusSpinnerContext) return;
        const frame = STATUS_SPINNER_FRAMES[statusSpinnerFrame] ?? STATUS_SPINNER_FRAMES[0];
        const model =
          config.provider && config.model
            ? statusSpinnerContext.modelRegistry.find(config.provider, config.model)
            : undefined;
        const effort = model
          ? clampThinkingLevel(model, config.thinkingLevel)
          : config.thinkingLevel;
        try {
          statusSpinnerContext.ui.setStatus(
            STATUS_KEY,
            `${frame} ${redactSensitiveText(config.model ?? "advisor").slice(0, 256)}:${effort} advising…`,
          );
        } catch {
          stopStatusSpinner();
        }
      };

      const startStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
        stopStatusSpinner();
        const executor = executorForSession();
        if (!executor) return;
        statusSpinnerContext = ctx;
        statusSpinnerOwner = owner;
        statusSpinnerDelay = advisorDelay(executor, STATUS_SPINNER_DELAY_MS, () => {
          statusSpinnerDelay = undefined;
          renderReviewStatus();
          if (ctx.mode !== "tui") return;
          statusSpinnerTimer = advisorInterval(executor, STATUS_SPINNER_INTERVAL_MS, () => {
            statusSpinnerFrame = (statusSpinnerFrame + 1) % STATUS_SPINNER_FRAMES.length;
            renderReviewStatus();
          });
        });
      };

      const settleStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
        if (statusSpinnerOwner !== owner) return;
        setAdvisorStatus(ctx, paused ? "advisor: paused" : undefined);
      };

      const recordSkip = (reason: AdvisorSkipReason): void => {
        const skipped = metrics.skippedReviews ?? {};
        skipped[reason] = incrementBounded(skipped[reason]);
        metrics.skippedReviews = skipped;
      };

      const recordUsage = (
        target: AdvisorSessionMetrics,
        usage: AdvisorUsageTelemetry,
        runtimeConfig: ResolvedAdvisorConfig,
      ): void => {
        target.cacheReadTokens = (target.cacheReadTokens ?? 0) + usage.cacheReadTokens;
        target.cacheWriteTokens = (target.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
        target.cost = (target.cost ?? 0) + usage.cost;
        target.inputTokens = (target.inputTokens ?? 0) + usage.inputTokens;
        target.modelResponses = incrementBounded(target.modelResponses);
        target.outputTokens = (target.outputTokens ?? 0) + usage.outputTokens;
        target.totalTokens = (target.totalTokens ?? 0) + usage.totalTokens;

        const provider = runtimeConfig.provider ?? "unknown";
        const model = runtimeConfig.model ?? "unknown";
        const key = stringifyJson([provider, model]);
        const previous = target.usageByModel?.[key];
        target.usageByModel ??= {};
        target.usageByModel[key] = {
          provider,
          model,
          responses: incrementBounded(previous?.responses),
          cacheReadTokens: (previous?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
          cacheWriteTokens: (previous?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
          cost: (previous?.cost ?? 0) + usage.cost,
          inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens,
          outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens,
          totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
        };
      };

      const recordReviewDuration = (target: AdvisorSessionMetrics, startedAt: number): void => {
        const duration = Math.max(
          0,
          (parentExecutor ? advisorNow(parentExecutor) : startedAt) - startedAt,
        );
        target.latestDurationMs = duration;
        target.settledReviews = incrementBounded(target.settledReviews);
        target.totalDurationMs = (target.totalDurationMs ?? 0) + duration;
      };

      const activeSeed = (ctx: ExtensionContext): string =>
        buildAdvisorContext({
          messages: activeContextMessages(ctx),
          candidate: lastCandidate?.candidate ?? "[No completed candidate at this cursor.]",
          maxChars: config.maxContextChars,
        }).transcript;

      const fingerprint = (ctx: ExtensionContext): string =>
        createLedgerFingerprint({
          provider: config.provider ?? "",
          model: config.model ?? "",
          cwd: ctx.cwd,
          guidance: instructions.content ?? "",
          fastMode: config.fastMode,
          thinkingLevel: config.thinkingLevel,
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
        activeTrajectory?.cancelTimer?.();
        activeTrajectory = undefined;
        activeToolCalls.clear();
      };

      const clearPendingRecovery = (): void => {
        const pending = pendingPersistentRecovery;
        pendingPersistentRecovery = undefined;
        abortInProgress = undefined;
        if (pending) {
          emissionGuard.rollback(pending.emission.rollback);
          findingDedupe.rollback(pending.dedupeRollback);
          pending.metrics.outcomes.suppressed += 1;
          interventionBudget.restore({ ...pending.budgetBefore, correctionUsed: true });
        }
      };

      let activeChildStart: CancellationLatch | undefined;
      const stopRuntimeUnlockedEffect = (): Effect.Effect<void> =>
        Effect.suspend(() => {
          clearPersistentTrajectory();
          clearPendingRecovery();
          const oldQueue = queue;
          const oldRuntime = runtime;
          const statusContext = statusSpinnerContext;
          queue = undefined;
          runtime = undefined;
          runtimeCursor = undefined;
          started = false;
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
            Effect.andThen(productionController.publish({ config, metrics, paused, started })),
          );
        });
      const cancelActiveChildStart = (): void => {
        activeChildStart?.cancel();
        activeChildStart = undefined;
        const current = runtime;
        if (current) parentExecutor?.fork(current.abort());
      };
      const stopRuntimeEffect = (): Effect.Effect<void> =>
        Effect.sync(cancelActiveChildStart).pipe(Effect.andThen(productionController.stopChild()));
      const stopRuntime = (): Promise<void> => runSessionEffect(stopRuntimeEffect());

      const startRuntimeEffect = (
        ctx: ExtensionContext,
        restoration: "preserve-live" | "restore-branch" = "preserve-live",
        allowDisabled = false,
      ): Effect.Effect<number | undefined> =>
        Effect.suspend(() => {
          const startEpoch = ++epoch;
          cancelActiveChildStart();
          let nextRuntime: AdvisorRuntimeServiceShape | undefined;
          const runtimeMetrics = metrics;
          const acquire = Effect.gen(function* () {
            yield* stopRuntimeUnlockedEffect();
            if (
              startEpoch !== epoch ||
              paused ||
              (!config.enabled && !allowDisabled) ||
              !config.configured
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
              routingState.reset();
              interventionBudget.reset();
              findingLifecycle.reset();
              emissionGuard.reset();
              latestStateSummary = "";
              latestDurableSummary = summarizeAdvisorReview();
              if (ledger) {
                routingState.restore({
                  cancellationLatched: ledger.routing.cancellationLatched,
                  completedPrimaryTurns: ledger.routing.completedPrimaryTurns,
                  immunityUntilCompletedTurn: ledger.routing.immunityUntilCompletedTurn,
                });
                interventionBudget.restore(ledger.routing.interventionBudget);
                findingLifecycle.restore(ledger.findingLifecycle);
                emissionGuard.reset(ledger.emissionHashes);
                latestDurableSummary = ledger.reviewSummary;
                latestStateSummary = renderDurableReviewSummary(ledger.reviewSummary);
              }
            }
            const runtimeConfig = { ...config };
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
              onUsage: (usage: AdvisorUsageTelemetry) =>
                recordUsage(runtimeMetrics, usage, runtimeConfig),
              onDiagnostic: (message: string) => {
                if (reportedDiagnostics.has(message)) return;
                reportedDiagnostics.add(message);
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
            if (startEpoch !== epoch || executor !== parentExecutor) {
              yield* nextRuntime.dispose();
              return undefined;
            }
            const nextQueue = yield* productionQueueService.make(nextRuntime, {
              onCheckpointStart: (request) => startStatusSpinner(ctx, request.checkpointId),
              onCheckpointSettled: (request) => settleStatusSpinner(ctx, request.checkpointId),
              onRuntimeReset: () => {
                runtimeMetrics.childResets = incrementBounded(runtimeMetrics.childResets);
              },
              getReprimeState: () => ({ seed: activeSeed(ctx), stateSummary: latestStateSummary }),
            });
            if (startEpoch !== epoch || executor !== parentExecutor) {
              yield* nextQueue.disposeEffect();
              return undefined;
            }
            if (childStartedOnce)
              runtimeMetrics.childResets = incrementBounded(runtimeMetrics.childResets);
            childStartedOnce = true;
            runtimeCursor = { anchor: parentAnchor(ctx), fingerprint: fingerprint(ctx) };
            queue = nextQueue;
            started = true;
            publishControllerSnapshot();
            return startEpoch;
          }).pipe(
            Effect.catch((error) =>
              Effect.gen(function* () {
                activeChildStart = undefined;
                if (nextRuntime) yield* nextRuntime.dispose();
                if (runtime === nextRuntime) runtime = undefined;
                if (startEpoch === epoch) {
                  runtimeMetrics.failure += 1;
                  runtimeMetrics.outcomes.failures += 1;
                  runtimeMetrics.lastAction = "failure";
                  const kind = classifyFailure(error);
                  runtimeMetrics.lastFailureKind = kind;
                  if (!reportedFailures.has(kind)) {
                    reportedFailures.add(kind);
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
          return productionController.replaceChild(
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
          const sessionMetrics = metrics;
          const expectedCancellationEpoch = cancellationEpoch;
          pendingExplicitStart = owner;
          return (
            started ? Effect.succeed(epoch) : startRuntimeEffect(ctx, "preserve-live", true)
          ).pipe(
            Effect.map((runtimeEpoch) => {
              if (
                pendingExplicitStart !== owner ||
                runtimeEpoch === undefined ||
                runtimeEpoch !== epoch ||
                metrics !== sessionMetrics ||
                cancellationEpoch !== expectedCancellationEpoch
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
        const route = routingState.snapshot;
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
              interventionBudget: pendingPersistentRecovery
                ? { ...pendingPersistentRecovery.budgetBefore, correctionUsed: true }
                : interventionBudget.snapshot,
              findingLifecycle: findingLifecycle.snapshot(),
              emissionHashes: emissionGuard
                .exportRecords()
                .filter(
                  (record) =>
                    !pendingPersistentRecovery ||
                    !record.endsWith(`:${pendingPersistentRecovery.emission.hash}`),
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
          metrics.discarded += 1;
          if (source !== "automatic-catch-up") metrics.outcomes.discarded += 1;
          metrics.lastAction = "discarded";
          return "silent";
        };
        if (ctx.signal?.aborted || expectedCancellationEpoch !== cancellationEpoch) {
          return discardAtDeliveryBoundary();
        }
        const review: AdvisorReview = {
          verdict: checkpoint.verdict,
          summary: checkpoint.summary,
          suggestions: checkpoint.suggestions ?? [],
          findings: checkpoint.findings,
        };
        const suppress = (lastAction: "suppressed" | "pass" = "suppressed"): "silent" => {
          metrics.outcomes.suppressed += 1;
          metrics.lastAction = lastAction;
          return "silent";
        };
        if (review.verdict === "suggest") {
          metrics.suggest = incrementBounded(metrics.suggest);
          if (
            phase !== "progress" ||
            source === "automatic-catch-up" ||
            source === "last" ||
            source === "verify"
          ) {
            return suppress();
          }
          const suggestion = perspectiveBudget.select(review.suggestions ?? []);
          if (!suggestion) return suppress();
          if (ctx.signal?.aborted || expectedCancellationEpoch !== cancellationEpoch) {
            return discardAtDeliveryBoundary();
          }
          const perspectiveReview: AdvisorReview = {
            verdict: "suggest",
            summary: review.summary,
            suggestions: [suggestion],
            findings: [],
          };
          perspectiveBudget.commit(suggestion);
          sendAdvisorPerspective(pi, config, perspectiveReview);
          metrics.outcomes.perspective += 1;
          metrics.perspectivesDelivered = incrementBounded(metrics.perspectivesDelivered);
          metrics.lastAction = "perspective";
          ingest({
            type: "advisor_intervention",
            findingIds: [],
            action: "perspective",
            requestSequence,
          });
          return "push-direct";
        }
        if (review.verdict === "pass") {
          if (phase === "final") {
            findingLifecycle.reconcile([], {
              scope,
              completedTurn: routingState.snapshot.completedPrimaryTurns,
              complete: true,
            });
          }
          metrics.pass += 1;
          if (source !== "automatic-catch-up") metrics.outcomes.pass += 1;
          metrics.lastAction = "pass";
          return "silent";
        }
        // Tool-calling turn boundaries keep the persistent Advisor caught up, but
        // they are not completed responses and must never emit "unfinished work"
        // critiques. Explicit trajectory checkpoints remain independently routable.
        if (source === "automatic-catch-up") {
          metrics.suppressedFindings = (metrics.suppressedFindings ?? 0) + review.findings.length;
          metrics.lastAction = "suppressed";
          return "silent";
        }
        metrics.outcomes.findings += 1;
        const gated = gateAdvisorFindings(review.findings);
        metrics.suppressedFindings = (metrics.suppressedFindings ?? 0) + gated.suppressed;
        const lifecycleFindings = findingLifecycle.reconcile(gated.actionable, {
          scope,
          completedTurn: routingState.snapshot.completedPrimaryTurns,
          complete: phase === "final",
        });
        const filtered = findingDedupe.filterWithRollback(
          lifecycleFindings.filter((finding) => finding.status === "open"),
          scope,
        );
        metrics.suppressedFindings = (metrics.suppressedFindings ?? 0) + filtered.suppressed;
        if (filtered.findings.length === 0) return suppress();
        const filteredReview = { ...review, findings: filtered.findings };
        const rollbackUndelivered = (emission?: { rollback: AdvisorEmissionRollback }): void => {
          findingDedupe.rollback(filtered.rollback);
          if (emission) emissionGuard.rollback(emission.rollback);
        };
        const emission = emissionGuard.evaluate(checkpoint.checkpointId, filteredReview);
        if (!emission.accepted) {
          rollbackUndelivered();
          return suppress(emission.reason === "pass" ? "pass" : "suppressed");
        }
        metrics.revise += 1;
        const severity = highestAdvisorSeverity(filteredReview);
        if (!severity) {
          rollbackUndelivered(emission);
          return "silent";
        }
        const trajectory =
          trajectoryId !== undefined && activeTrajectory?.id === trajectoryId
            ? activeTrajectory
            : undefined;
        const aborting = Boolean(
          (abortInProgress &&
            abortInProgress.epoch === epoch &&
            abortInProgress.parentTurnId === parentTurnId &&
            abortInProgress.cancellationEpoch === cancellationEpoch) ||
          (pendingPersistentRecovery &&
            pendingPersistentRecovery.epoch === epoch &&
            pendingPersistentRecovery.parentTurnId === parentTurnId &&
            pendingPersistentRecovery.cancellationEpoch === cancellationEpoch),
        );
        const historicalManual = source === "last" || source === "verify";
        const explicitManual = historicalManual || source === "next";
        const budgeted = !explicitManual;
        if (budgeted && !interventionBudget.canDeliver(severity)) {
          rollbackUndelivered(emission);
          return suppress();
        }
        let route = explicitManual
          ? severity === "nit"
            ? "silent"
            : "push-direct"
          : routeAdvisorFinding({
              severity,
              policy: config.reviewPolicy,
              parentState: aborting
                ? "aborting"
                : ctx.isIdle()
                  ? phase === "final"
                    ? "final"
                    : "idle"
                  : "active",
              immunityActive: routingState.immunityActive,
              cancellationLatched: routingState.cancellationLatched,
              sameTurnStrongSignal:
                severity === "blocker" &&
                Boolean(trajectory?.loopConfirmed && trajectory.generation === parentTurnId),
              abortSafe: Boolean(
                trajectory?.abortAllowed && trajectory.toolDetector.activeToolCount === 0,
              ),
            });
        const correctionRoute =
          route === "steer-live" || route === "trigger-correction" || route === "abort-recover";
        if (budgeted && correctionRoute && !interventionBudget.canCorrect()) route = "push-direct";
        if (budgeted && route === "push-direct" && ctx.isIdle()) route = "silent";

        // Cancellation is synchronous and wins over a provider completion queued in
        // the same tick. Recheck at the exact delivery boundary before every send path.
        if (ctx.signal?.aborted || expectedCancellationEpoch !== cancellationEpoch) {
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
          findingLifecycle.acknowledge(findingIds);
          if (budgeted) interventionBudget.commit(severity, correction);
          recordReceipt(findingIds);
          ingest({
            type: "advisor_intervention",
            findingIds,
            action: outcome,
            requestSequence,
          });
          metrics.outcomes[outcome] += 1;
          metrics.interventionsDelivered = (metrics.interventionsDelivered ?? 0) + 1;
          return reviewWithAcknowledgedFindings(filteredReview, findingIds);
        };
        const pushAdvice = (): void => {
          sendAdvisorAdvice(pi, config, recordDelivery(false, "advice"));
        };
        if (route === "silent") {
          rollbackUndelivered(emission);
          suppress();
        } else if (route === "push-direct") {
          pushAdvice();
          metrics.lastAction = "advice";
        } else if (route === "steer-live" || route === "trigger-correction") {
          const outcome = phase === "progress" ? "guidance" : "revision";
          sendCorrection(
            pi,
            config,
            recordDelivery(true, outcome),
            phase,
            route === "trigger-correction",
            false,
          );
          routingState.armInterruption();
          metrics.lastAction = outcome;
        } else {
          if (!trajectory || trajectoryId === undefined) {
            pushAdvice();
            metrics.lastAction = "advice";
            return "push-direct";
          }
          const budgetBefore = interventionBudget.snapshot;
          if (budgeted) interventionBudget.commit(severity, true);
          pendingPersistentRecovery = {
            review: filteredReview,
            config: { ...config },
            phase,
            epoch,
            parentTurnId,
            configRevision,
            cancellationEpoch,
            recovering: true,
            findingIds,
            metrics,
            budgetBefore,
            dedupeRollback: filtered.rollback,
            emission: {
              checkpointId: checkpoint.checkpointId,
              hash: emission.hash,
              rollback: emission.rollback,
            },
          };
          abortInProgress = {
            epoch,
            parentTurnId,
            turnIndex: trajectory.turnIndex,
            trajectoryId,
            cancellationEpoch,
          };
          metrics.lastAction = "recovery";
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
        if ((!queue || !started) && (!config.enabled || !config.configured || paused)) {
          return undefined;
        }
        let validForDelivery = true;
        let requestEpoch = epoch;
        let requestCancellationEpoch = cancellationEpoch;
        let activeQueue: AdvisorReviewQueue | undefined;
        let activeCheckpointId: string | undefined;
        const requestMetrics = metrics;
        const startedAt = parentExecutor ? advisorNow(parentExecutor) : 0;
        let durationRecorded = false;
        let outcomeRecorded = false;
        const finishReviewDuration = () => {
          if (durationRecorded) return;
          durationRecorded = true;
          recordReviewDuration(requestMetrics, startedAt);
        };
        const discardRequest = (): CheckpointSettlement => {
          if (!outcomeRecorded) {
            outcomeRecorded = true;
            requestMetrics.discarded += 1;
            if (options.source !== "automatic-catch-up") requestMetrics.outcomes.discarded += 1;
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
            if (restartEpoch === undefined || restartEpoch !== epoch) return "discarded";
          }
          if (
            !validForDelivery ||
            metrics !== requestMetrics ||
            !queue ||
            !started ||
            !runtimeCursor
          )
            return "discarded";
          if (options.trajectoryId !== undefined && activeTrajectory?.id !== options.trajectoryId)
            return "discarded";

          activeQueue = queue;
          requestEpoch = epoch;
          requestCancellationEpoch = cancellationEpoch;
          const requestParentTurnId = parentTurnId;
          const requestConfigRevision = configRevision;
          const anchor = parentAnchor(options.ctx);
          const id = `advisor-${requestEpoch}-${++checkpointId}`;
          activeCheckpointId = id;
          const scope = lifecycleScope(options.ctx);
          requestMetrics.attempted += 1;
          let checkpoint = yield* activeQueue
            .checkpointEffect({
              checkpointId: id,
              focus: options.focus,
              parentTurnId: requestParentTurnId,
            })
            .pipe(Effect.mapError(extensionError("checkpoint")));
          const requestIsCurrent = () =>
            validForDelivery &&
            requestEpoch === epoch &&
            requestCancellationEpoch === cancellationEpoch &&
            requestParentTurnId === parentTurnId &&
            requestConfigRevision === configRevision &&
            !options.ctx.signal?.aborted &&
            (!options.requiresEnabled || (config.enabled && !paused && config.configured)) &&
            !options.ctx.hasPendingMessages() &&
            branchContains(options.ctx, anchor) &&
            (options.trajectoryId === undefined || activeTrajectory?.id === options.trajectoryId);
          if (!requestIsCurrent()) return discardRequest();
          const verifyBlocker =
            options.source !== "automatic-catch-up" &&
            options.source !== "last" &&
            options.source !== "verify" &&
            config.reviewPolicy !== "advisory" &&
            checkpoint.findings.some(isVerificationCandidate);
          if (verifyBlocker) {
            requestMetrics.blockerVerificationAttempts =
              (requestMetrics.blockerVerificationAttempts ?? 0) + 1;
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
            requestMetrics.blockersVerified =
              (requestMetrics.blockersVerified ?? 0) + retainedBlockers.size;
            requestMetrics.blockersRejected =
              (requestMetrics.blockersRejected ?? 0) +
              Math.max(0, proposedBlockers.size - retainedBlockers.size);
          }
          finishReviewDuration();
          if (
            !validForDelivery ||
            requestEpoch !== epoch ||
            requestCancellationEpoch !== cancellationEpoch ||
            requestParentTurnId !== parentTurnId ||
            requestConfigRevision !== configRevision ||
            options.ctx.signal?.aborted ||
            (options.requiresEnabled && (!config.enabled || paused || !config.configured)) ||
            options.ctx.hasPendingMessages() ||
            !branchContains(options.ctx, anchor)
          ) {
            requestMetrics.lastAction = "discarded";
            return discardRequest();
          }
          if (options.trajectoryId !== undefined && activeTrajectory?.id !== options.trajectoryId) {
            requestMetrics.lastAction = "discarded";
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
            scope,
            requestCancellationEpoch,
            options.abortOnBlocker ? options.trajectoryId : undefined,
          );
          runtimeCursor = { anchor, fingerprint: fingerprint(options.ctx) };
          persistLedger(anchor, options.ctx);
          outcomeRecorded = true;
          return "completed" as const;
        }).pipe(
          Effect.catch((error) =>
            Effect.sync((): CheckpointSettlement => {
              finishReviewDuration();
              if (requestEpoch !== epoch || !validForDelivery) return discardRequest();
              outcomeRecorded = true;
              requestMetrics.failure += 1;
              if (options.source !== "automatic-catch-up") requestMetrics.outcomes.failures += 1;
              requestMetrics.lastAction = "failure";
              const kind = classifyFailure(error);
              requestMetrics.lastFailureKind = kind;
              const failureDetails = {
                contextChars: activeQueue?.backlog ?? 0,
                durationMs: requestMetrics.latestDurationMs ?? 0,
                error,
                ...(config.model ? { model: config.model } : {}),
                ...(config.provider ? { provider: config.provider } : {}),
                timeoutMs: config.timeoutMs,
              };
              if (logFailure) void Promise.resolve(logFailure(config.configPath, failureDetails));
              else parentExecutor?.fork(logAdvisorFailureEffect(config.configPath, failureDetails));
              if (!reportedFailures.has(kind)) {
                reportedFailures.add(kind);
                notifyBestEffort(
                  options.ctx,
                  `Advisor ${kind} failure; keeping the primary response. See /advisor status --verbose.`,
                  "warning",
                );
              }
              if (kind === "authentication") void stopRuntime();
              return "failed";
            }),
          ),
          Effect.withSpan("pi-advisor.parent.checkpoint"),
        );
        const invalidate = () => {
          validForDelivery = false;
        };
        let cancellationStarted = false;
        const cancel = () => {
          validForDelivery = false;
          if (cancellationStarted) return;
          cancellationStarted = true;
          const targetQueue = activeQueue;
          const targetId = activeCheckpointId;
          const executor = executorForSession();
          if (targetQueue && targetId && executor) {
            try {
              executor.fork(targetQueue.cancelCheckpointEffect(targetId));
            } catch {
              // Session disposal already owns any checkpoint left at this boundary.
            }
          }
        };
        const finalizeCancellation = () => {
          finishReviewDuration();
          discardRequest();
        };
        activeCheckpointInvalidators.add(invalidate);
        activeCheckpointCancellationFinalizers.add(finalizeCancellation);
        const settlement = Fiber.await(
          parentExecutor.fork(
            checkpointSettlement.pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  activeCheckpointInvalidators.delete(invalidate);
                  activeCheckpointCancellationFinalizers.delete(finalizeCancellation);
                }),
              ),
            ),
          ),
        ).pipe(
          Effect.map(
            Exit.match({
              onFailure: () => "failed" as const,
              onSuccess: (value) => value,
            }),
          ),
        );
        return { invalidate, cancel, settlement };
      };

      const awaitCatchUpEffectOwned = (
        handle: AdvisorCheckpointHandle,
        ctx: ExtensionContext,
      ): Effect.Effect<void> =>
        Effect.suspend(() => {
          const catchUpMetrics = metrics;
          catchUpMetrics.catchUpWaits = incrementBounded(catchUpMetrics.catchUpWaits);
          catchUpMetrics.activeCatchUpWaits = incrementBounded(catchUpMetrics.activeCatchUpWaits);
          const signal = ctx.signal;
          let timeoutRecorded = false;
          const recordTimeout = () => {
            if (timeoutRecorded) return;
            timeoutRecorded = true;
            catchUpMetrics.catchUpTimeouts = incrementBounded(catchUpMetrics.catchUpTimeouts);
          };
          const cancellation = signal
            ? Effect.callback<"cancelled">((resume) => {
                let recorded = false;
                const onAbort = () => {
                  if (recorded) return;
                  recorded = true;
                  handle.invalidate();
                  cancellationEpoch += 1;
                  routingState.latchCancellation();
                  clearPendingRecovery();
                  pendingInterventionReceipt = undefined;
                  persistCurrentLedger(ctx);
                  catchUpMetrics.catchUpCancellations = incrementBounded(
                    catchUpMetrics.catchUpCancellations,
                  );
                  resume(Effect.sync(() => handle.cancel()).pipe(Effect.as("cancelled" as const)));
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
            Effect.sync(() => {
              recordTimeout();
              handle.cancel();
            }),
          ).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome === "timeout") {
                  recordTimeout();
                } else if (outcome === "failed" && !timeoutRecorded) {
                  catchUpMetrics.catchUpFailures = incrementBounded(catchUpMetrics.catchUpFailures);
                }
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                catchUpMetrics.activeCatchUpWaits = Math.max(
                  0,
                  (catchUpMetrics.activeCatchUpWaits ?? 1) - 1,
                );
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
          queue?.ingest(parentTurnId, input);
        } catch {
          // Parent streaming and tool events always remain fail-open.
        }
      };

      const cancelEffect = (
        ctx: Parameters<AdvisorCommandActions["cancel"]>[0],
      ): Effect.Effect<boolean> =>
        Effect.suspend(() => {
          const hadRequestedReview = reviewNext;
          const hadExplicitStart = pendingExplicitStart !== undefined;
          const hadRecovery = Boolean(pendingPersistentRecovery);
          reviewNext = false;
          pendingExplicitStart = undefined;
          clearPendingRecovery();
          pendingInterventionReceipt = undefined;
          routingState.latchCancellation();
          cancellationEpoch += 1;
          persistCurrentLedger(ctx);
          for (const invalidate of activeCheckpointInvalidators) invalidate();
          for (const finalize of activeCheckpointCancellationFinalizers) finalize();
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
          return startRuntimeEffect(ctx).pipe(Effect.as(hadWork));
        });

      const commandActions: AdvisorCommandActions = {
        cancel: (ctx) => runSessionEffect(cancelEffect(ctx)),
        pause: (ctx) => {
          paused = true;
          reviewNext = false;
          pendingExplicitStart = undefined;
          clearPendingRecovery();
          pendingInterventionReceipt = undefined;
          routingState.latchCancellation();
          cancellationEpoch += 1;
          persistCurrentLedger(ctx);
          ++epoch;
          void stopRuntime();
          setAdvisorStatus(ctx, "advisor: paused");
        },
        resume: (ctx) => {
          paused = false;
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
          reviewNext = true;
        },
      };

      registerAdvisorCommands(
        capturingPi,
        {
          get: () => config,
          getMetrics: () => ({
            ...metrics,
            activeToolNames: queue?.activeToolNames ?? [],
            backlog: queue?.backlog ?? 0,
            backgroundState: queue?.hasActiveCheckpoint
              ? "reviewing"
              : queue && queue.pendingCheckpoints > 0
                ? "queued"
                : "idle",
            childResets: metrics.childResets ?? 0,
            guidancePaths: instructions.paths,
            hasLastCandidate: Boolean(lastCandidate),
            findingLifecycle: findingLifecycle.counts(),
            interventionBudget: interventionBudget.snapshot,
            paused,
            processedSequence: queue?.processedThrough ?? 0,
            queuedReviews: queue?.pendingCheckpoints ?? 0,
            reviewNext,
            sequence: queue?.sequence ?? 0,
          }),
          persist: (patch, path) => {
            const executor = executorForSession();
            return executor
              ? executor.run(writeAdvisorConfigPatchEffect(patch, path))
              : Promise.reject(
                  new AdvisorExtensionError({
                    operation: "config persistence",
                    message: "Advisor session runtime is not active.",
                  }),
                );
          },
          update: (next) => {
            const enabledChanged = config.enabled !== next.enabled;
            const disabling = config.enabled && !next.enabled;
            config = next;
            configRevision += 1;
            publishControllerSnapshot();
            if (enabledChanged) paused = false;
            clearPendingRecovery();
            findingDedupe.reset();
            findingLifecycle.reset();
            perspectiveBudget.reset();
            perspectiveCheckpointUsed = false;
            interventionBudget.reset();
            latestStateSummary = "";
            latestDurableSummary = summarizeAdvisorReview();
            pendingInterventionReceipt = undefined;
            emissionGuard.reset();
            pendingExplicitStart = undefined;
            if (disabling) routingState.latchCancellation();
            cancellationEpoch += 1;
            if (activeContext) persistCurrentLedger(activeContext);
            if (activeContext) void startRuntime(activeContext);
          },
        },
        commandActions,
        (effect) => runSessionEffect(effect),
      );

      const sessionInitializeEffect = (ctx: ExtensionContext) =>
        Effect.gen(function* () {
          ++parentGeneration;
          ++epoch;
          cancellationEpoch += 1;
          pendingExplicitStart = undefined;
          for (const invalidate of activeCheckpointInvalidators) invalidate();
          for (const finalize of activeCheckpointCancellationFinalizers) finalize();
          removeHostCancellation?.();
          removeHostCancellation = undefined;
          const latchHostCancellation = () => {
            routingState.latchCancellation();
            clearPendingRecovery();
            pendingInterventionReceipt = undefined;
            cancellationEpoch += 1;
            persistCurrentLedger(ctx);
          };
          ctx.signal?.addEventListener("abort", latchHostCancellation, { once: true });
          removeHostCancellation = () =>
            ctx.signal?.removeEventListener("abort", latchHostCancellation);
          if (ctx.signal?.aborted) latchHostCancellation();
          activeContext = ctx;
          const configPath = config.configPath || getAdvisorConfigPath();
          const configEffect = loadConfig
            ? commandAdapter
                .fromPromise(() => Promise.resolve(loadConfig(configPath)))
                .pipe(Effect.mapError(extensionError("config load")))
            : loadAdvisorConfigEffect(configPath).pipe(
                Effect.mapError(extensionError("config load")),
              );
          yield* stopRuntimeUnlockedEffect();
          config = yield* configEffect;
          configRevision += 1;
          metrics = emptySessionMetrics();
          childStartedOnce = false;
          instructions = yield* loadAdvisorInstructionsEffect(
            config.configPath,
            ctx.cwd,
            ctx.isProjectTrusted(),
          ).pipe(Effect.mapError(extensionError("instruction load")));
          paused = false;
          reviewNext = false;
          pendingExplicitStart = undefined;
          lastCandidate = undefined;
          parentTurnId = 0;
          checkpointId = 0;
          cancellationEpoch += 1;
          findingDedupe.reset();
          findingLifecycle.reset();
          perspectiveBudget.reset();
          perspectiveCheckpointUsed = false;
          interventionBudget.reset();
          pendingInterventionReceipt = undefined;
          requestSequence = 0;
          emissionGuard.reset();
          routingState.reset();
          latestStateSummary = "";
          latestDurableSummary = summarizeAdvisorReview();
          reportedFailures.clear();
          reportedDiagnostics.clear();
          publishControllerSnapshot();
          if (!config.configured) warnIfSetupRequired(ctx, config, () => undefined);
          yield* startRuntimeEffect(ctx, "restore-branch");
        });
      const sessionShutdownEffect = () =>
        Effect.sync(() => {
          ++parentGeneration;
          ++epoch;
          pendingExplicitStart = undefined;
          activeContext = undefined;
          removeHostCancellation?.();
          removeHostCancellation = undefined;
          for (const invalidate of activeCheckpointInvalidators) invalidate();
          for (const finalize of activeCheckpointCancellationFinalizers) finalize();
        }).pipe(Effect.andThen(stopRuntimeEffect()));
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
          findingDedupe.reset();
          findingLifecycle.reset();
          perspectiveBudget.reset();
          perspectiveCheckpointUsed = false;
          interventionBudget.reset();
          pendingInterventionReceipt = undefined;
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
        pendingInterventionReceipt = undefined;
        requestSequence += 1;
        interventionBudget.reset();
        perspectiveBudget.reset();
        perspectiveCheckpointUsed = false;
        findingDedupe.reset();
        emissionGuard.reset();
        cancellationEpoch += 1;
        routingState.clearCancellationForGenuineUserPrompt();
        persistCurrentLedger(ctx);
        const text = contentText(event.message);
        ingest({ type: "user", text: text || "[user content unavailable]" });
        activeContext = ctx;
      });

      capturingPi.on("turn_start", (event, ctx) => {
        clearPersistentTrajectory();
        clearPendingRecovery();
        const receipt = pendingInterventionReceipt;
        if (
          receipt &&
          receipt.cancellationEpoch === cancellationEpoch &&
          receipt.requestSequence === requestSequence
        ) {
          ingest({
            type: "advisor_intervention_receipt",
            findingIds: receipt.ids,
            requestSequence,
          });
          metrics.interventionsAcknowledged =
            (metrics.interventionsAcknowledged ?? 0) + receipt.count;
        }
        pendingInterventionReceipt = undefined;
        parentTurnId += 1;
        if (!config.enabled || paused || !config.configured) return;
        const observation: ActiveTurnObservation = {
          abortAllowed: false,
          ctx,
          detector: new AdvisorTrajectoryDetector(),
          toolDetector: new AdvisorToolTrajectoryDetector(),
          generation: parentTurnId,
          id: ++trajectorySequence,
          loopConfirmed: false,
          reviewQueued: false,
          text: "",
          thinkingChars: 0,
          turnIndex: event.turnIndex,
        };
        activeTrajectory = observation;
        const executor = executorForSession();
        if (!executor) return;
        observation.cancelTimer = advisorDelay(executor, LONG_TURN_REVIEW_MS, () => {
          if (activeTrajectory !== observation || observation.reviewQueued) return;
          observation.reviewQueued = true;
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
        const observation = activeTrajectory;
        if (!observation || observation.reviewQueued) return;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") return;
        const channel = update.type === "thinking_delta" ? "thinking" : "text";
        if (channel === "thinking") observation.thinkingChars += update.delta.length;
        else
          observation.text = `${observation.text}${update.delta}`.slice(
            -MAX_TRAJECTORY_EVIDENCE_CHARS,
          );
        if (observation.loopChannel === "thinking" && channel === "text")
          observation.abortAllowed = false;
        const signal = observation.detector.push(channel, update.delta);
        if (!signal) return;
        observation.abortAllowed = observation.toolDetector.activeToolCount === 0;
        observation.loopChannel = signal.channel;
        observation.loopConfirmed = true;
        observation.loopReason = `${signal.channel} stream ${signal.reason}`;
        const queueReview = () => {
          if (activeTrajectory !== observation || observation.reviewQueued) return;
          observation.reviewQueued = true;
          observation.cancelTimer?.();
          requestCheckpoint({
            ctx: observation.ctx,
            focus: "trajectory",
            phase: "progress",
            source: "automatic-progress",
            requiresEnabled: true,
            trajectoryId: observation.id,
            abortOnBlocker: observation.abortAllowed,
          });
        };
        queueReview();
      });

      capturingPi.on("tool_execution_start", (event, _ctx) => {
        activeToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
        if (activeTrajectory) {
          activeTrajectory.abortAllowed = false;
          activeTrajectory.toolDetector.start(event.toolCallId);
          activeTrajectory.cancelTimer?.();
          delete activeTrajectory.cancelTimer;
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
        const observation = activeTrajectory;
        if (!observation) return;
        const terminal = {
          parentTurnId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: call?.args ?? "[call arguments unavailable]",
          result: event.result,
          isError: event.isError,
        };
        const concreteProgress = observation.toolDetector.isMateriallyNovelTerminal(
          terminal,
          observation.loopConfirmed,
        );
        const signal = observation.toolDetector.end(terminal);
        observation.abortAllowed = observation.toolDetector.activeToolCount === 0;
        if (concreteProgress) {
          observation.toolDetector.markConcreteProgress();
          observation.loopConfirmed = false;
          delete observation.loopReason;
          observation.abortAllowed = false;
          return;
        }
        if (!signal || observation.reviewQueued) return;
        observation.loopConfirmed = true;
        observation.loopReason = signal.reason;
        observation.abortAllowed = signal.abortSafe;
        ingest({
          type: "trajectory_signal",
          kind: signal.kind,
          confidence: signal.confidence,
          reason: signal.reason,
          evidence: signal.evidence,
          abortSafe: signal.abortSafe,
        });
        observation.reviewQueued = true;
        requestCheckpoint({
          ctx: observation.ctx,
          focus: "trajectory",
          phase: "progress",
          source: "automatic-progress",
          requiresEnabled: true,
          trajectoryId: observation.id,
          abortOnBlocker: true,
        });
      });

      capturingPi.on("agent_settled", (_event, ctx) => {
        const recovery = pendingPersistentRecovery;
        if (
          !recovery ||
          recovery.epoch !== epoch ||
          recovery.parentTurnId !== parentTurnId ||
          recovery.configRevision !== configRevision ||
          recovery.cancellationEpoch !== cancellationEpoch ||
          !config.enabled ||
          paused ||
          !config.configured ||
          ctx.signal?.aborted ||
          !ctx.isIdle() ||
          ctx.hasPendingMessages()
        ) {
          clearPendingRecovery();
          return;
        }
        pendingPersistentRecovery = undefined;
        abortInProgress = undefined;
        findingLifecycle.acknowledge(recovery.findingIds);
        sendTriggeredCorrection(
          pi,
          recovery.config,
          reviewWithAcknowledgedFindings(recovery.review, recovery.findingIds),
          recovery.phase,
          recovery.recovering,
        );
        recovery.metrics.outcomes.recovery += 1;
        recovery.metrics.interventionsDelivered =
          (recovery.metrics.interventionsDelivered ?? 0) + 1;
        recordReceipt(recovery.findingIds);
        ingest({
          type: "advisor_intervention",
          findingIds: recovery.findingIds,
          action: "recovery",
          requestSequence,
        });
        routingState.armInterruption();
        persistLedger(parentAnchor(ctx), ctx);
      });

      capturingPi.on("turn_end", (event, ctx) => {
        const trajectory = activeTrajectory;
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
        if (stopReason === "stop") routingState.completePrimaryTurn();
        if (!classification.eligible) {
          recordSkip(classification.reason === "empty" ? "empty" : "incomplete");
          if (stopReason !== "stop" && trajectory) trajectory.abortAllowed = false;
          if (stopReason === "aborted") {
            const provenance = abortInProgress;
            const matchingAdvisorAbort = Boolean(
              provenance &&
              provenance.epoch === epoch &&
              provenance.parentTurnId === parentTurnId &&
              provenance.cancellationEpoch === cancellationEpoch &&
              provenance.turnIndex === event.turnIndex &&
              trajectory?.id === provenance.trajectoryId,
            );
            if (matchingAdvisorAbort) {
              abortInProgress = undefined;
            } else {
              clearPendingRecovery();
              routingState.latchCancellation();
              cancellationEpoch += 1;
              persistCurrentLedger(ctx);
            }
          }
          return;
        }
        const messages = activeContextMessages(ctx);
        if (classification.phase === "final") {
          lastCandidate = {
            candidate: classification.candidate,
            generation: parentTurnId,
            messages,
            sessionEpoch: epoch,
          };
        }
        const explicitlyRequested = classification.phase === "final" && reviewNext;
        if (explicitlyRequested) {
          reviewNext = false;
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
        if (!explicitlyRequested && !config.enabled) {
          recordSkip("disabled");
          return;
        }
        if (!explicitlyRequested && paused) {
          recordSkip("session-paused");
          return;
        }
        if (!config.configured) {
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
          });
        });
      const invokeCommand = (
        name: string,
        args: string,
        ctx: Parameters<NonNullable<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>>[1],
      ): Effect.Effect<unknown, AdvisorExtensionError> =>
        Effect.suspend(() => {
          const handler = options.commandHandlers.get(name);
          if (!handler) return Effect.void;
          return commandAdapter
            .fromPromise(() => Promise.resolve(handler(args, ctx)))
            .pipe(Effect.mapError(extensionError(`command ${name}`)));
        });
      const service = AdvisorController.of({
        snapshot,
        publish: productionController.publish,
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
        stopRuntimeUnlockedEffect().pipe(Effect.andThen(stopOwnedChild)),
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
    const dependenciesLayer = Layer.mergeAll(
      advisorRuntimeServiceLayer(sessionExecutor),
      advisorReviewQueueServiceLayer,
      PiCommandAdapter.layer,
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
            return Promise.resolve(projected(args, ctx)).then(() => undefined);
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
): void {
  if (!config.enabled || config.configured) return;
  markShown();
  ctx.ui.notify(
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
