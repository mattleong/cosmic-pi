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
import { stringifyRedactedObservation } from "./observation-protocol.ts";
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
import { AdvisorFindingDedupe } from "./dedupe.ts";
import { AdvisorEmissionGuard, highestAdvisorSeverity } from "./emission-guard.ts";
import { buildAdvisorContext } from "./context.ts";
import { logAdvisorFailure } from "./failure-log.ts";
import { loadAdvisorInstructions, type LoadedAdvisorInstructions } from "./instructions.ts";
import { ADVISOR_REVIEW_MESSAGE_TYPE, registerAdvisorReviewRenderer } from "./renderer.ts";
import {
  AdvisorReviewParseError,
  buildAdvisorAdvice,
  buildProgressSteer,
  buildRevisionSteer,
  type AdvisorReview,
  type AdvisorReviewFocus,
} from "./review.ts";
import { AdvisorRoutingState, routeAdvisorFinding, type AdvisorRoute } from "./routing.ts";
import {
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
type ReviewSource = "automatic-final" | "automatic-progress" | "next" | "last" | "verify";

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
          emission: { checkpointId: string; hash: string };
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
    const routingState = new AdvisorRoutingState();
    const emissionGuard = new AdvisorEmissionGuard();
    const activeToolCalls = new Map<string, { toolName: string; args: unknown }>();
    let latestStateSummary = "";
    let latestDurableSummary: AdvisorDurableReviewSummary = summarizeAdvisorReview();
    const reportedFailures = new Set<string>();
    let statusSpinnerContext: ExtensionContext | undefined;
    let statusSpinnerDelay: ReturnType<typeof setTimeout> | undefined;
    let statusSpinnerFrame = 0;
    let statusSpinnerTimer: ReturnType<typeof setInterval> | undefined;

    const stopStatusSpinner = (): void => {
      if (statusSpinnerDelay) clearTimeout(statusSpinnerDelay);
      if (statusSpinnerTimer) clearInterval(statusSpinnerTimer);
      statusSpinnerContext = undefined;
      statusSpinnerDelay = undefined;
      statusSpinnerFrame = 0;
      statusSpinnerTimer = undefined;
    };

    const setAdvisorStatus = (ctx: ExtensionContext, text?: string): void => {
      stopStatusSpinner();
      ctx.ui.setStatus(STATUS_KEY, text);
    };

    const renderReviewStatus = (): void => {
      if (!statusSpinnerContext) return;
      const frame = STATUS_SPINNER_FRAMES[statusSpinnerFrame] ?? STATUS_SPINNER_FRAMES[0];
      statusSpinnerContext.ui.setStatus(STATUS_KEY, `${frame} advisor reviewing…`);
    };

    const startStatusSpinner = (ctx: ExtensionContext): void => {
      stopStatusSpinner();
      statusSpinnerContext = ctx;
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

    const recordSkip = (reason: AdvisorSkipReason): void => {
      const skipped = metrics.skippedReviews ?? {};
      skipped[reason] = incrementBounded(skipped[reason]);
      metrics.skippedReviews = skipped;
    };

    const recordUsage = (usage: AdvisorUsageTelemetry): void => {
      metrics.cacheReadTokens = (metrics.cacheReadTokens ?? 0) + usage.cacheReadTokens;
      metrics.cacheWriteTokens = (metrics.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      metrics.cost = (metrics.cost ?? 0) + usage.cost;
      metrics.inputTokens = (metrics.inputTokens ?? 0) + usage.inputTokens;
      metrics.outputTokens = (metrics.outputTokens ?? 0) + usage.outputTokens;
      metrics.totalTokens = (metrics.totalTokens ?? 0) + usage.totalTokens;
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
        emissionGuard.forget(pending.emission.checkpointId, pending.emission.hash);
        findingDedupe.reset();
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
    ): Promise<void> => {
      const startEpoch = ++epoch;
      await stopRuntime();
      if (
        startEpoch !== epoch ||
        paused ||
        (!config.enabled && !allowDisabled) ||
        !config.configured
      )
        return;
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
        emissionGuard.reset();
        latestStateSummary = "";
        latestDurableSummary = summarizeAdvisorReview();
        if (ledger) {
          routingState.restore({
            cancellationLatched: ledger.routing.cancellationLatched,
            completedPrimaryTurns: ledger.routing.completedPrimaryTurns,
            immunityUntilCompletedTurn: ledger.routing.immunityUntilCompletedTurn,
          });
          emissionGuard.reset(ledger.emissionHashes);
          latestDurableSummary = ledger.reviewSummary;
          latestStateSummary = renderDurableReviewSummary(ledger.reviewSummary);
        }
      }
      try {
        await nextRuntime.start({
          ctx,
          config: { ...config },
          seed: activeSeed(ctx),
          stateSummary:
            restoration === "restore-branch" && ledger
              ? renderDurableReviewSummary(ledger.reviewSummary)
              : latestStateSummary,
          instructions: instructions.content,
          onUsage: recordUsage,
          onDiagnostic: (message) => ctx.ui.notify(message, "warning"),
        });
        if (startEpoch !== epoch) {
          await nextRuntime.dispose();
          return;
        }
        if (childStartedOnce) metrics.childResets = incrementBounded(metrics.childResets);
        childStartedOnce = true;
        runtimeCursor = { anchor: parentAnchor(ctx), fingerprint: fingerprint(ctx) };
        queue = new AdvisorReviewQueue(nextRuntime, {
          onCheckpointStart: () => {
            metrics.attempted += 1;
            startStatusSpinner(ctx);
          },
          onCheckpointSettled: () => setAdvisorStatus(ctx, paused ? "advisor: paused" : undefined),
          onRuntimeReset: () => {
            metrics.childResets = incrementBounded(metrics.childResets);
          },
          getReprimeState: () => ({ seed: activeSeed(ctx), stateSummary: latestStateSummary }),
        });
        started = true;
      } catch (error) {
        if (startEpoch !== epoch) return;
        metrics.failure += 1;
        metrics.lastAction = "failure";
        const kind = classifyFailure(error);
        metrics.lastFailureKind = kind;
        if (!reportedFailures.has(kind)) {
          reportedFailures.add(kind);
          ctx.ui.notify(`Advisor ${kind} failure; primary work remains unaffected.`, "warning");
        }
        await nextRuntime.dispose().catch(() => undefined);
        if (runtime === nextRuntime) runtime = undefined;
      }
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
      if (ctx.signal?.aborted || expectedCancellationEpoch !== cancellationEpoch) {
        metrics.discarded += 1;
        metrics.lastAction = "discarded";
        return "silent";
      }
      const review: AdvisorReview = {
        verdict: checkpoint.verdict,
        summary: checkpoint.summary,
        findings: checkpoint.findings,
      };
      if (review.verdict === "pass") {
        metrics.pass += 1;
        metrics.lastAction = "pass";
        return "silent";
      }
      const filtered = findingDedupe.filter(review.findings, scope);
      metrics.suppressedFindings = (metrics.suppressedFindings ?? 0) + filtered.suppressed;
      if (filtered.findings.length === 0) {
        metrics.lastAction = "suppressed";
        return "silent";
      }
      const filteredReview = { ...review, findings: filtered.findings };
      const emission = emissionGuard.evaluate(checkpoint.checkpointId, filteredReview);
      if (!emission.accepted) {
        metrics.lastAction = emission.reason === "pass" ? "pass" : "suppressed";
        return "silent";
      }
      metrics.revise += 1;
      const severity = highestAdvisorSeverity(filteredReview);
      if (!severity) return "silent";
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
      const route = historicalManual
        ? severity === "nit"
          ? "silent"
          : "preserve-next-turn"
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
            manualAction: source === "next",
            sameTurnStrongSignal:
              severity === "blocker" &&
              Boolean(trajectory?.loopConfirmed && trajectory.generation === parentTurnId),
            abortSafe: Boolean(
              trajectory?.abortAllowed && trajectory.toolDetector.activeToolCount === 0,
            ),
          });

      // Cancellation is synchronous and wins over a provider completion queued in
      // the same tick. Recheck at the exact delivery boundary before every send path.
      if (ctx.signal?.aborted || expectedCancellationEpoch !== cancellationEpoch) {
        emissionGuard.forget(checkpoint.checkpointId, emission.hash);
        metrics.discarded += 1;
        metrics.lastAction = "discarded";
        return "silent";
      }
      if (route === "silent") {
        metrics.lastAction = "suppressed";
      } else if (route === "preserve-next-turn") {
        sendAdvisorAdvice(pi, config, filteredReview, "nextTurn");
        metrics.lastAction = "advice";
      } else if (route === "steer-live") {
        sendLiveCorrection(pi, config, filteredReview, phase);
        routingState.armInterruption();
        metrics.lastAction = phase === "progress" ? "guidance" : "revision";
      } else if (route === "trigger-correction") {
        sendTriggeredCorrection(pi, config, filteredReview, phase);
        routingState.armInterruption();
        metrics.lastAction = phase === "progress" ? "guidance" : "revision";
      } else {
        if (!trajectory || trajectoryId === undefined) {
          sendAdvisorAdvice(pi, config, filteredReview, "nextTurn");
          metrics.lastAction = "advice";
          return "preserve-next-turn";
        }
        pendingPersistentRecovery = {
          review: filteredReview,
          config: { ...config },
          phase,
          epoch,
          parentTurnId,
          configRevision,
          cancellationEpoch,
          recovering: true,
          emission: { checkpointId: checkpoint.checkpointId, hash: emission.hash },
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
      setAdvisorStatus(ctx);
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
      const startedAt = Date.now();
      const settlement: Promise<CheckpointSettlement> = (async () => {
        const cursorMismatch =
          !runtimeCursor ||
          runtimeCursor.fingerprint !== fingerprint(options.ctx) ||
          !branchContains(options.ctx, runtimeCursor.anchor);
        if (cursorMismatch) {
          // One bounded restart remains part of this same checkpoint settlement,
          // so turn_end's hard catch-up barrier covers both re-seed and review.
          await startRuntime(options.ctx, "restore-branch", !options.requiresEnabled);
        }
        if (!validForDelivery || !queue || !started || !runtimeCursor) return "discarded";

        activeQueue = queue;
        requestEpoch = epoch;
        requestCancellationEpoch = cancellationEpoch;
        const requestParentTurnId = parentTurnId;
        const requestConfigRevision = configRevision;
        const requestSessionId = options.ctx.sessionManager.getSessionId?.();
        const anchor = parentAnchor(options.ctx);
        const id = `advisor-${requestEpoch}-${++checkpointId}`;
        const scope = `${requestSessionId ?? requestEpoch}:${runtimeCursor.anchor ?? "root"}`;
        const checkpoint = await activeQueue.checkpoint({
          checkpointId: id,
          focus: options.focus,
          parentTurnId: requestParentTurnId,
        });
        metrics.latestDurationMs = Math.max(0, Date.now() - startedAt);
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
          metrics.discarded += 1;
          metrics.lastAction = "discarded";
          return "discarded";
        }
        if (options.trajectoryId !== undefined && activeTrajectory?.id !== options.trajectoryId) {
          metrics.discarded += 1;
          metrics.lastAction = "discarded";
          return "discarded";
        }

        latestStateSummary = checkpoint.stateSummary;
        latestDurableSummary = summarizeAdvisorReview(checkpoint);
        const route = deliver(
          checkpoint,
          options.phase,
          options.source,
          options.ctx,
          scope,
          requestCancellationEpoch,
          options.abortOnBlocker ? options.trajectoryId : undefined,
        );
        runtimeCursor = { anchor, fingerprint: fingerprint(options.ctx) };
        if (route !== "abort-recover") persistLedger(anchor, options.ctx);
        return "completed";
      })().catch((error): CheckpointSettlement => {
        metrics.latestDurationMs = Math.max(0, Date.now() - startedAt);
        if (requestEpoch !== epoch || !validForDelivery) {
          metrics.discarded += 1;
          return "failed";
        }
        metrics.failure += 1;
        metrics.lastAction = "failure";
        const kind = classifyFailure(error);
        metrics.lastFailureKind = kind;
        logFailure(config.configPath, {
          contextChars: activeQueue?.backlog ?? 0,
          durationMs: metrics.latestDurationMs,
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
      metrics.catchUpWaits = incrementBounded(metrics.catchUpWaits);
      metrics.activeCatchUpWaits = incrementBounded(metrics.activeCatchUpWaits);
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
          persistCurrentLedger(ctx);
          metrics.catchUpCancellations = incrementBounded(metrics.catchUpCancellations);
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
          metrics.catchUpTimeouts = incrementBounded(metrics.catchUpTimeouts);
        } else if (outcome === "failed") {
          metrics.catchUpFailures = incrementBounded(metrics.catchUpFailures);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
        metrics.activeCatchUpWaits = Math.max(0, (metrics.activeCatchUpWaits ?? 1) - 1);
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
        reviewNext = false;
        clearPendingRecovery();
        routingState.latchCancellation();
        cancellationEpoch += 1;
        persistCurrentLedger(ctx);
        const hadWork = Boolean(
          queue && (queue.backlog > 0 || queue.processedThrough < queue.sequence),
        );
        void startRuntime(ctx);
        return hadWork;
      },
      pause: (ctx) => {
        paused = true;
        reviewNext = false;
        clearPendingRecovery();
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
        if (!lastCandidate) return false;
        if (!started) await startRuntime(ctx, "preserve-live", true);
        const handle = requestCheckpoint({
          ctx,
          focus,
          phase: "final",
          source: focus === "verification" ? "verify" : "last",
          requiresEnabled: false,
        });
        return Boolean(handle);
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
          backgroundState: queue ? (queue.pendingCheckpoints > 0 ? "queued" : "idle") : "idle",
          childResets: metrics.childResets ?? 0,
          guidancePaths: instructions.paths,
          hasLastCandidate: Boolean(lastCandidate),
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
          if (disabling) {
            routingState.latchCancellation();
            if (activeContext) persistCurrentLedger(activeContext);
          }
          findingDedupe.reset();
          emissionGuard.reset();
          clearPendingRecovery();
          cancellationEpoch += 1;
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
      lastCandidate = undefined;
      parentTurnId = 0;
      checkpointId = 0;
      cancellationEpoch += 1;
      findingDedupe.reset();
      emissionGuard.reset();
      routingState.reset();
      latestStateSummary = "";
      latestDurableSummary = summarizeAdvisorReview();
      reportedFailures.clear();
      if (!config.configured) warnIfSetupRequired(ctx, config, () => undefined);
      await startRuntime(ctx, "restore-branch");
    });

    pi.on("session_shutdown", async () => {
      ++epoch;
      activeContext = undefined;
      await stopRuntime();
    });

    pi.on("session_compact", async (_event, ctx) => {
      ingest({ type: "compaction", marker: "Parent context was compacted." });
      await startRuntime(ctx);
    });
    pi.on("session_tree", async (_event, ctx) => {
      ingest({ type: "tree", marker: "Parent active branch changed." });
      lastCandidate = undefined;
      findingDedupe.reset();
      await startRuntime(ctx, "restore-branch");
    });

    pi.on("message_end", (event, ctx) => {
      if (!isGenuineUserMessage(event.message)) return;
      clearPersistentTrajectory();
      clearPendingRecovery();
      cancellationEpoch += 1;
      routingState.clearCancellationForGenuineUserPrompt();
      const text = contentText(event.message);
      ingest({ type: "user", text: text || "[user content unavailable]" });
      activeContext = ctx;
    });

    pi.on("turn_start", (event, ctx) => {
      clearPersistentTrajectory();
      clearPendingRecovery();
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
      sendTriggeredCorrection(
        pi,
        recovery.config,
        recovery.review,
        recovery.phase,
        recovery.recovering,
      );
      routingState.armInterruption();
      persistLedger(parentAnchor(ctx), ctx);
      setAdvisorStatus(ctx);
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
        if (!started) await startRuntime(ctx, "preserve-live", true);
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
      const handle = requestCheckpoint({
        ctx,
        focus: classification.phase === "progress" ? "trajectory" : "standard",
        phase: classification.phase,
        source: explicitlyRequested
          ? "next"
          : classification.phase === "progress"
            ? "automatic-progress"
            : "automatic-final",
        requiresEnabled: !explicitlyRequested,
      });
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
    outputTokens: 0,
    pass: 0,
    revise: 0,
    skippedReviews: {},
    suppressedFindings: 0,
    totalTokens: 0,
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

function sendLiveCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
): void {
  sendCorrection(pi, config, review, phase, false, false);
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

function sendCorrection(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  phase: ReviewPhase,
  triggerTurn: boolean,
  recovering: boolean,
): void {
  if (!config.provider || !config.model) return;
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content:
        phase === "progress" ? buildProgressSteer(review, recovering) : buildRevisionSteer(review),
      display: true,
      details: {
        action: recovering ? "recovery" : phase === "progress" ? "guidance" : "revision",
        review,
        provider: config.provider,
        model: config.model,
      },
    },
    triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
  );
}

function sendAdvisorAdvice(
  pi: ExtensionAPI,
  config: ResolvedAdvisorConfig,
  review: AdvisorReview,
  deliverAs: "nextTurn" = "nextTurn",
): void {
  if (!config.provider || !config.model) return;
  pi.sendMessage(
    {
      customType: ADVISOR_REVIEW_MESSAGE_TYPE,
      content: buildAdvisorAdvice(review),
      display: true,
      details: {
        action: "advice",
        review,
        provider: config.provider,
        model: config.model,
      },
    },
    { deliverAs },
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
