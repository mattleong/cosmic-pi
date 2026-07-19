import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { isRecord } from "./utils.ts";
import {
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionContext,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { AdvisorUsageTelemetry } from "./client.ts";
import {
  AdvisorRuntime,
  type AdvisorCheckpoint,
  type AdvisorRuntimeDriver,
} from "./advisor-runtime.ts";
import { AdvisorReviewQueue } from "./review-queue.ts";
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
import { loadAdvisorConfig, type ResolvedAdvisorConfig } from "./config.ts";
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
import { logAdvisorFailure } from "./failure-log.ts";
import { loadAdvisorInstructions, type LoadedAdvisorInstructions } from "./instructions.ts";
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

const STATUS_KEY = "pi-advisor";
const STATUS_SPINNER_DELAY_MS = 200;
const STATUS_SPINNER_INTERVAL_MS = 120;
const STATUS_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const ADVISOR_CATCH_UP_TIMEOUT_MS = 30_000;
type ReviewPhase = "final" | "progress";
type CheckpointSettlement = "completed" | "discarded" | "failed";

interface AdvisorCheckpointHandle {
  invalidate(): void;
  settlement: Promise<CheckpointSettlement>;
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
  timer?: ReturnType<typeof setTimeout>;
  turnIndex: number;
}

interface LastCandidate {
  candidate: string;
  generation: number;
  messages: unknown[];
  sessionEpoch: number;
}

export interface AdvisorExtensionDependencies {
  loadConfig?: typeof loadAdvisorConfig;
  logFailure?: typeof logAdvisorFailure;
  createRuntime?: () => AdvisorRuntimeDriver;
  /** Test seam only. Production always uses the hard exported cap. */
  catchUpTimeoutMs?: number;
}

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
  const loadConfig = dependencies.loadConfig ?? loadAdvisorConfig;
  const logFailure = dependencies.logFailure ?? logAdvisorFailure;
  const createRuntime = dependencies.createRuntime ?? (() => new AdvisorRuntime());
  const catchUpTimeoutMs = Math.min(
    ADVISOR_CATCH_UP_TIMEOUT_MS,
    Math.max(1, dependencies.catchUpTimeoutMs ?? ADVISOR_CATCH_UP_TIMEOUT_MS),
  );

  return function registerPersistentAdvisorExtension(pi: ExtensionAPI): void {
    let config = loadConfig();
    let configRevision = 0;
    let epoch = 0;
    let parentTurnId = 0;
    let checkpointId = 0;
    let queue: AdvisorReviewQueue | undefined;
    let runtime: AdvisorRuntimeDriver | undefined;
    let runtimeCursor: { anchor: string | null; fingerprint: string } | undefined;
    let activeContext: ExtensionContext | undefined;
    let metrics = emptySessionMetrics();
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
    let statusSpinnerDelay: ReturnType<typeof setTimeout> | undefined;
    let statusSpinnerFrame = 0;
    let statusSpinnerOwner: string | undefined;
    let statusSpinnerTimer: ReturnType<typeof setInterval> | undefined;

    const stopStatusSpinner = (): void => {
      if (statusSpinnerDelay) clearTimeout(statusSpinnerDelay);
      if (statusSpinnerTimer) clearInterval(statusSpinnerTimer);
      statusSpinnerContext = undefined;
      statusSpinnerDelay = undefined;
      statusSpinnerFrame = 0;
      statusSpinnerOwner = undefined;
      statusSpinnerTimer = undefined;
    };

    const setAdvisorStatus = (ctx: ExtensionContext, text?: string): void => {
      stopStatusSpinner();
      ctx.ui.setStatus(STATUS_KEY, text);
    };

    const renderReviewStatus = (): void => {
      if (!statusSpinnerContext) return;
      const frame = STATUS_SPINNER_FRAMES[statusSpinnerFrame] ?? STATUS_SPINNER_FRAMES[0];
      const model =
        config.provider && config.model
          ? statusSpinnerContext.modelRegistry.find(config.provider, config.model)
          : undefined;
      const effort = model ? clampThinkingLevel(model, config.thinkingLevel) : config.thinkingLevel;
      statusSpinnerContext.ui.setStatus(
        STATUS_KEY,
        `${frame} ${redactSensitiveText(config.model ?? "advisor").slice(0, 256)}:${effort} advising…`,
      );
    };

    const startStatusSpinner = (ctx: ExtensionContext, owner: string): void => {
      stopStatusSpinner();
      statusSpinnerContext = ctx;
      statusSpinnerOwner = owner;
      statusSpinnerDelay = setTimeout(() => {
        statusSpinnerDelay = undefined;
        renderReviewStatus();
        if (ctx.mode !== "tui") return;
        statusSpinnerTimer = setInterval(() => {
          statusSpinnerFrame = (statusSpinnerFrame + 1) % STATUS_SPINNER_FRAMES.length;
          renderReviewStatus();
        }, STATUS_SPINNER_INTERVAL_MS);
        statusSpinnerTimer.unref();
      }, STATUS_SPINNER_DELAY_MS);
      statusSpinnerDelay.unref();
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
      const key = JSON.stringify([provider, model]);
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
      const duration = Math.max(0, Date.now() - startedAt);
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
        (entry) => !(entry.type === "custom" && entry.customType === ADVISOR_CHECKPOINT_ENTRY_TYPE),
      );
      return `branch:${root?.id ?? parentAnchor(ctx) ?? "root"}`;
    };

    const branchContains = (ctx: ExtensionContext, anchor: string | null): boolean => {
      if (!anchor || typeof ctx.sessionManager.getBranch !== "function") return true;
      return ctx.sessionManager.getBranch().some((entry) => entry.id === anchor);
    };

    const clearPersistentTrajectory = (): void => {
      if (activeTrajectory?.timer) clearTimeout(activeTrajectory.timer);
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

    const stopRuntime = async (): Promise<void> => {
      const statusContext = statusSpinnerContext;
      if (statusContext) setAdvisorStatus(statusContext);
      clearPersistentTrajectory();
      clearPendingRecovery();
      const oldQueue = queue;
      const oldRuntime = runtime;
      queue = undefined;
      runtime = undefined;
      runtimeCursor = undefined;
      started = false;
      if (oldQueue) await oldQueue.dispose().catch(() => undefined);
      else if (oldRuntime) await oldRuntime.dispose().catch(() => undefined);
    };

    const startRuntime = async (
      ctx: ExtensionContext,
      restoration: "preserve-live" | "restore-branch" = "preserve-live",
      allowDisabled = false,
    ): Promise<number | undefined> => {
      const startEpoch = ++epoch;
      await stopRuntime();
      if (
        startEpoch !== epoch ||
        paused ||
        (!config.enabled && !allowDisabled) ||
        !config.configured
      )
        return;
      const runtimeMetrics = metrics;
      const nextRuntime = createRuntime();
      runtime = nextRuntime;
      const branch =
        typeof ctx.sessionManager.getBranch === "function" ? ctx.sessionManager.getBranch() : [];
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
      try {
        const runtimeConfig = { ...config };
        await nextRuntime.start({
          ctx,
          config: runtimeConfig,
          seed: activeSeed(ctx),
          stateSummary:
            restoration === "restore-branch" && ledger
              ? renderDurableReviewSummary(ledger.reviewSummary)
              : latestStateSummary,
          instructions: instructions.content,
          onUsage: (usage) => recordUsage(runtimeMetrics, usage, runtimeConfig),
          onDiagnostic: (message) => {
            if (reportedDiagnostics.has(message)) return;
            reportedDiagnostics.add(message);
            ctx.ui.notify(message, "warning");
          },
        });
        if (startEpoch !== epoch) {
          await nextRuntime.dispose();
          return;
        }
        if (childStartedOnce)
          runtimeMetrics.childResets = incrementBounded(runtimeMetrics.childResets);
        childStartedOnce = true;
        runtimeCursor = { anchor: parentAnchor(ctx), fingerprint: fingerprint(ctx) };
        queue = new AdvisorReviewQueue(nextRuntime, {
          onCheckpointStart: (request) => startStatusSpinner(ctx, request.checkpointId),
          onCheckpointSettled: (request) => settleStatusSpinner(ctx, request.checkpointId),
          onRuntimeReset: () => {
            runtimeMetrics.childResets = incrementBounded(runtimeMetrics.childResets);
          },
          getReprimeState: () => ({ seed: activeSeed(ctx), stateSummary: latestStateSummary }),
        });
        started = true;
        return startEpoch;
      } catch (error) {
        if (startEpoch !== epoch) return;
        runtimeMetrics.failure += 1;
        runtimeMetrics.outcomes.failures += 1;
        runtimeMetrics.lastAction = "failure";
        const kind = classifyFailure(error);
        runtimeMetrics.lastFailureKind = kind;
        if (!reportedFailures.has(kind)) {
          reportedFailures.add(kind);
          ctx.ui.notify(`Advisor ${kind} failure; primary work remains unaffected.`, "warning");
        }
        await nextRuntime.dispose().catch(() => undefined);
        if (runtime === nextRuntime) runtime = undefined;
        return undefined;
      }
    };

    const runWithExplicitRuntime = async <T>(
      ctx: ExtensionContext,
      action: () => T,
    ): Promise<T | undefined> => {
      const owner = ++explicitStartSequence;
      const sessionMetrics = metrics;
      const expectedCancellationEpoch = cancellationEpoch;
      pendingExplicitStart = owner;
      const runtimeEpoch = started ? epoch : await startRuntime(ctx, "preserve-live", true);
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
    };

    const persistLedger = (anchor: string | null, ctx: ExtensionContext): void => {
      if (!anchor || typeof pi.appendEntry !== "function") return;
      const route = routingState.snapshot;
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
      const requestMetrics = metrics;
      const startedAt = Date.now();
      let durationRecorded = false;
      const finishReviewDuration = () => {
        if (durationRecorded) return;
        durationRecorded = true;
        recordReviewDuration(requestMetrics, startedAt);
      };
      const discardRequest = (): CheckpointSettlement => {
        requestMetrics.discarded += 1;
        if (options.source !== "automatic-catch-up") requestMetrics.outcomes.discarded += 1;
        return "discarded";
      };
      const settlement: Promise<CheckpointSettlement> = (async () => {
        const cursorMismatch =
          !runtimeCursor ||
          runtimeCursor.fingerprint !== fingerprint(options.ctx) ||
          !branchContains(options.ctx, runtimeCursor.anchor);
        if (cursorMismatch) {
          // One bounded restart remains part of this same checkpoint settlement,
          // so turn_end's hard catch-up barrier covers both re-seed and review.
          const restartEpoch = await startRuntime(
            options.ctx,
            "restore-branch",
            !options.requiresEnabled,
          );
          if (restartEpoch === undefined || restartEpoch !== epoch) return "discarded";
        }
        if (!validForDelivery || metrics !== requestMetrics || !queue || !started || !runtimeCursor)
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
        const scope = lifecycleScope(options.ctx);
        requestMetrics.attempted += 1;
        let checkpoint = await activeQueue.checkpoint({
          checkpointId: id,
          focus: options.focus,
          parentTurnId: requestParentTurnId,
        });
        const verifyBlocker =
          options.source !== "automatic-catch-up" &&
          options.source !== "last" &&
          options.source !== "verify" &&
          config.reviewPolicy !== "advisory" &&
          checkpoint.findings.some(isVerificationCandidate);
        if (verifyBlocker) {
          requestMetrics.blockerVerificationAttempts =
            (requestMetrics.blockerVerificationAttempts ?? 0) + 1;
          const verification = await activeQueue.checkpoint({
            checkpointId: `advisor-${requestEpoch}-${++checkpointId}`,
            focus: "blocker-verification",
            parentTurnId: requestParentTurnId,
            verificationReview: checkpoint,
          });
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
        return "completed";
      })().catch((error): CheckpointSettlement => {
        finishReviewDuration();
        if (requestEpoch !== epoch || !validForDelivery) return discardRequest();
        requestMetrics.failure += 1;
        if (options.source !== "automatic-catch-up") requestMetrics.outcomes.failures += 1;
        requestMetrics.lastAction = "failure";
        const kind = classifyFailure(error);
        requestMetrics.lastFailureKind = kind;
        logFailure(config.configPath, {
          contextChars: activeQueue?.backlog ?? 0,
          durationMs: requestMetrics.latestDurationMs ?? 0,
          error,
          model: config.model,
          provider: config.provider,
          timeoutMs: config.timeoutMs,
        });
        if (!reportedFailures.has(kind)) {
          reportedFailures.add(kind);
          options.ctx.ui.notify(
            `Advisor ${kind} failure; keeping the primary response. See /advisor status --verbose.`,
            "warning",
          );
        }
        if (kind === "authentication") void stopRuntime();
        return "failed";
      });
      return {
        invalidate: () => {
          validForDelivery = false;
        },
        settlement,
      };
    };

    const awaitCatchUp = async (
      handle: AdvisorCheckpointHandle,
      ctx: ExtensionContext,
    ): Promise<void> => {
      const catchUpMetrics = metrics;
      catchUpMetrics.catchUpWaits = incrementBounded(catchUpMetrics.catchUpWaits);
      catchUpMetrics.activeCatchUpWaits = incrementBounded(catchUpMetrics.activeCatchUpWaits);
      const signal = ctx.signal;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let cancellationRecorded = false;
      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeout = setTimeout(() => resolve("timeout"), catchUpTimeoutMs);
        timeout.unref();
      });
      const cancellationPromise = new Promise<"cancelled">((resolve) => {
        if (!signal) return;
        onAbort = () => {
          if (cancellationRecorded) return;
          cancellationRecorded = true;
          // Invalidate and advance the cancellation epoch synchronously in the
          // abort event dispatch, before any provider-completion microtask sends.
          handle.invalidate();
          cancellationEpoch += 1;
          routingState.latchCancellation();
          clearPendingRecovery();
          pendingInterventionReceipt = undefined;
          persistCurrentLedger(ctx);
          catchUpMetrics.catchUpCancellations = incrementBounded(
            catchUpMetrics.catchUpCancellations,
          );
          resolve("cancelled");
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const outcome = await Promise.race([
          handle.settlement,
          timeoutPromise,
          cancellationPromise,
        ]);
        if (outcome === "timeout") {
          handle.invalidate();
          catchUpMetrics.catchUpTimeouts = incrementBounded(catchUpMetrics.catchUpTimeouts);
        } else if (outcome === "failed") {
          catchUpMetrics.catchUpFailures = incrementBounded(catchUpMetrics.catchUpFailures);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        catchUpMetrics.activeCatchUpWaits = Math.max(
          0,
          (catchUpMetrics.activeCatchUpWaits ?? 1) - 1,
        );
      }
    };

    const ingest = (input: Parameters<AdvisorReviewQueue["ingest"]>[1]): void => {
      try {
        queue?.ingest(parentTurnId, input);
      } catch {
        // Parent streaming and tool events always remain fail-open.
      }
    };

    const commandActions: AdvisorCommandActions = {
      cancel: (ctx) => {
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
        void startRuntime(ctx);
        return hadWork;
      },
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
      reviewLast: async (ctx, focus) => {
        const candidate = lastCandidate;
        if (!candidate) return "unavailable";
        const handle = await runWithExplicitRuntime(ctx, () => {
          if (lastCandidate !== candidate) return undefined;
          return requestCheckpoint({
            ctx,
            focus,
            phase: "final",
            source: focus === "verification" ? "verify" : "last",
            requiresEnabled: false,
          });
        });
        return handle ? "started" : "cancelled";
      },
      reviewNext: () => {
        reviewNext = true;
      },
    };

    registerAdvisorReviewRenderer(pi);
    registerAdvisorCommands(
      pi,
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
        update: (next) => {
          const enabledChanged = config.enabled !== next.enabled;
          const disabling = config.enabled && !next.enabled;
          config = next;
          configRevision += 1;
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
    );

    pi.on("session_start", async (_event, ctx) => {
      activeContext = ctx;
      config = loadConfig(config.configPath);
      configRevision += 1;
      metrics = emptySessionMetrics();
      childStartedOnce = false;
      instructions = loadAdvisorInstructions(config.configPath, ctx.cwd, ctx.isProjectTrusted());
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
      if (!config.configured) warnIfSetupRequired(ctx, config, () => undefined);
      await startRuntime(ctx, "restore-branch");
    });

    pi.on("session_shutdown", async () => {
      ++epoch;
      pendingExplicitStart = undefined;
      activeContext = undefined;
      await stopRuntime();
    });

    pi.on("session_compact", async (_event, ctx) => {
      ingest({ type: "compaction", marker: "Parent context was compacted." });
      pendingExplicitStart = undefined;
      await startRuntime(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      ingest({ type: "tree", marker: "Parent active branch changed." });
      pendingExplicitStart = undefined;
      lastCandidate = undefined;
      findingDedupe.reset();
      findingLifecycle.reset();
      perspectiveBudget.reset();
      perspectiveCheckpointUsed = false;
      interventionBudget.reset();
      pendingInterventionReceipt = undefined;
      await startRuntime(ctx, "restore-branch");
    });

    pi.on("message_end", (event, ctx) => {
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

    pi.on("turn_start", (event, ctx) => {
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
      observation.timer = setTimeout(() => {
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
      }, LONG_TURN_REVIEW_MS);
      observation.timer.unref();
    });

    pi.on("message_update", (event, _ctx) => {
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
        if (observation.timer) clearTimeout(observation.timer);
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

    pi.on("tool_execution_start", (event, _ctx) => {
      activeToolCalls.set(event.toolCallId, { toolName: event.toolName, args: event.args });
      if (activeTrajectory) {
        activeTrajectory.abortAllowed = false;
        activeTrajectory.toolDetector.start(event.toolCallId);
        if (activeTrajectory.timer) clearTimeout(activeTrajectory.timer);
        activeTrajectory.timer = undefined;
      }
      ingest({
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: safeObservationJson(event.args),
      });
    });
    pi.on("tool_execution_update", (event, _ctx) => {
      ingest({
        type: "tool_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        update: safeObservationJson(event.partialResult),
      });
    });
    pi.on("tool_execution_end", (event, _ctx) => {
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
        observation.loopReason = undefined;
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

    pi.on("agent_settled", (_event, ctx) => {
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
      recovery.metrics.interventionsDelivered = (recovery.metrics.interventionsDelivered ?? 0) + 1;
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

    pi.on("turn_end", async (event, ctx) => {
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
        const handle = await runWithExplicitRuntime(ctx, () =>
          requestCheckpoint({
            ctx,
            focus: "standard",
            phase: "final",
            source: "next",
            requiresEnabled: false,
          }),
        );
        if (handle) await awaitCatchUp(handle, ctx);
        return;
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
      if (handle) await awaitCatchUp(handle, ctx);
    });
  };
}

export const advisorExtension = createAdvisorExtension();

function contentText(message: unknown): string {
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
  if (!isRecord(message)) return "error";
  return message.stopReason === "aborted" ||
    message.stopReason === "error" ||
    message.stopReason === "length"
    ? message.stopReason
    : "stop";
}

function assistantToolCalls(message: unknown): string[] {
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
  return isRecord(message) && message.role === "user";
}

type CandidateClassification =
  | { eligible: true; candidate: string; phase: ReviewPhase }
  | {
      eligible: false;
      reason: "not-assistant" | "empty" | "incomplete";
    };

function classifyReviewCheckpoint(event: TurnEndEvent): CandidateClassification {
  const message = event.message;
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
      args = part.arguments === undefined ? "" : ` ${JSON.stringify(part.arguments)}`;
    } catch {
      args = " [unserializable arguments]";
    }
    return [`[tool call: ${name}${args}]`];
  });
  const text = parts.join("\n").trim();
  return text || undefined;
}

function assistantText(message: unknown): string | undefined {
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
