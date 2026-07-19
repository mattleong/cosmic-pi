import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "./config.ts";
import { maskIdentifier, sanitizeDiagnosticError } from "./format.ts";
import { readXaiAuth } from "./auth.ts";
import {
  AUTH_FILE,
  BILLING_BASE_URL,
  type UsageSnapshot,
  formatResetCountdown,
  formatUsageDetails,
  formatUsageSnapshot,
  requestXaiUsage,
} from "./usage.ts";

export function isXaiSubscriptionModel(
  ctx: ExtensionContext,
  cfg: ResolvedConfig,
  isUsingOAuth?: boolean,
): boolean {
  const model = ctx.model;
  if (!model || model.provider !== "xai") return false;
  return (
    !cfg.usage.showOnlyOnSubscriptionModels ||
    (isUsingOAuth ?? ctx.modelRegistry.isUsingOAuth(model))
  );
}

const STALE_EXTENSION_CONTEXT_MESSAGE = "This extension ctx is stale";

function isStaleExtensionContextError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(STALE_EXTENSION_CONTEXT_MESSAGE);
}

type UsageRefreshOptions = { notify?: boolean; force?: boolean };

type QueuedUsageRefresh = {
  ctx: ExtensionContext;
  generation: number;
  notify?: boolean;
  force?: boolean;
};

export class UsageController {
  private usageSnapshot: UsageSnapshot | undefined;
  private usageUpdatedAt: number | undefined;
  private usageError: string | undefined;
  private usageLastFetchAt: number | undefined;
  private usageTimer: ReturnType<typeof setInterval> | undefined;
  private usageRefreshInFlight = false;
  private queuedUsageRefresh: QueuedUsageRefresh | undefined;
  private shuttingDown = false;
  private usageAbortController: AbortController | undefined;
  private sessionAbortSignal: AbortSignal | undefined;
  private sessionAbortHandler: (() => void) | undefined;
  private sessionGeneration = 0;
  private readonly getConfig: (ctx: ExtensionContext) => ResolvedConfig;
  private readonly updateFooter: (ctx: ExtensionContext) => void;

  constructor(
    getConfig: (ctx: ExtensionContext) => ResolvedConfig,
    updateFooter: (ctx: ExtensionContext) => void,
  ) {
    this.getConfig = getConfig;
    this.updateFooter = updateFooter;
  }

  get snapshot(): UsageSnapshot | undefined {
    return this.usageSnapshot;
  }

  statusLine(
    ctx: ExtensionContext,
    cfg = this.getConfig(ctx),
    isUsingOAuth?: boolean,
  ): string | undefined {
    return this.usageSnapshot &&
      !this.usageError &&
      cfg.usage.enabled &&
      isXaiSubscriptionModel(ctx, cfg, isUsingOAuth)
      ? formatUsageSnapshot(this.usageSnapshot, cfg.usage)
      : undefined;
  }

  formatStatus(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return "Usage display is disabled.";
    if (!isXaiSubscriptionModel(ctx, cfg))
      return "Usage hidden: current model is not an xAI subscription model.";
    if (this.usageError) return `Usage unavailable: ${this.usageError}`;
    if (!this.usageSnapshot) return "Usage unavailable.";
    const stale =
      this.usageUpdatedAt && Date.now() - this.usageUpdatedAt > cfg.usage.refreshIntervalMs * 2
        ? ` | stale ${formatResetCountdown((Date.now() - this.usageUpdatedAt) / 1000)}`
        : "";
    return `${formatUsageDetails(this.usageSnapshot)}${stale}`;
  }

  formatDebug(ctx: ExtensionContext): string {
    const cfg = this.getConfig(ctx);
    const auth = readXaiAuth();
    return [
      `Usage enabled: ${cfg.usage.enabled}`,
      `Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`,
      `Current model eligible: ${isXaiSubscriptionModel(ctx, cfg)}`,
      `Requires subscription model: ${cfg.usage.showOnlyOnSubscriptionModels}`,
      `Auth: ${auth ? "found" : "missing"}`,
      `Team ID: ${maskIdentifier(auth?.teamId) ?? "none"}`,
      `Last fetch: ${this.usageLastFetchAt ? new Date(this.usageLastFetchAt).toLocaleTimeString() : "never"}`,
      `Last successful update: ${this.usageUpdatedAt ? new Date(this.usageUpdatedAt).toLocaleTimeString() : "never"}`,
      `Last error: ${this.usageError ?? "none"}`,
      `Refresh interval: ${cfg.usage.refreshIntervalMs}ms`,
      `Endpoint: ${BILLING_BASE_URL}/billing*`,
      `Auth file: ${AUTH_FILE}`,
    ].join("\n");
  }

  private isGenerationCurrent(generation: number): boolean {
    return !this.shuttingDown && generation === this.sessionGeneration;
  }

  private deactivateGeneration(generation: number): void {
    if (generation !== this.sessionGeneration) return;
    this.shuttingDown = true;
    this.sessionGeneration++;
    this.queuedUsageRefresh = undefined;
    this.usageAbortController?.abort();
    this.usageAbortController = undefined;
    this.stopTimer();
  }

  private handleStaleContextError(error: unknown, generation: number): boolean {
    if (!isStaleExtensionContextError(error)) return false;
    this.deactivateGeneration(generation);
    return true;
  }

  async refresh(
    ctx: ExtensionContext,
    options?: UsageRefreshOptions,
    generation = this.sessionGeneration,
  ): Promise<void> {
    if (!this.isGenerationCurrent(generation)) return;

    try {
      if (!ctx.hasUI) return;
    } catch (error) {
      this.handleStaleContextError(error, generation);
      return;
    }

    if (this.usageRefreshInFlight) {
      const queued =
        this.queuedUsageRefresh?.generation === generation ? this.queuedUsageRefresh : undefined;
      this.queuedUsageRefresh = {
        ctx,
        generation,
        notify: queued?.notify || options?.notify,
        force: queued?.force || options?.force,
      };
      return;
    }

    this.usageRefreshInFlight = true;
    try {
      const cfg = this.getConfig(ctx);
      if (!this.isGenerationCurrent(generation)) return;

      if (!cfg.usage.enabled) {
        this.usageSnapshot = undefined;
        this.usageError = "Usage display is disabled.";
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      if (!isXaiSubscriptionModel(ctx, cfg)) {
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
        return;
      }
      const shouldThrottle =
        !options?.force &&
        !options?.notify &&
        this.usageLastFetchAt !== undefined &&
        Date.now() - this.usageLastFetchAt < cfg.usage.refreshIntervalMs;
      if (shouldThrottle) return;
      this.usageLastFetchAt = Date.now();
      this.usageAbortController = new AbortController();
      const timeoutSignal = AbortSignal.timeout(10_000);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal, this.usageAbortController.signal])
        : AbortSignal.any([timeoutSignal, this.usageAbortController.signal]);
      const snapshot = await requestXaiUsage(ctx, signal);
      if (!this.isGenerationCurrent(generation)) return;

      this.usageSnapshot = snapshot;
      this.usageUpdatedAt = snapshot ? Date.now() : undefined;
      this.usageError = snapshot
        ? undefined
        : `Missing xAI OAuth credentials in ${AUTH_FILE}. Run /login xai.`;
      this.updateFooter(ctx);
      if (options?.notify)
        ctx.ui.notify(this.formatStatus(ctx), this.usageSnapshot ? "info" : "warning");
    } catch (error) {
      if (this.handleStaleContextError(error, generation) || !this.isGenerationCurrent(generation))
        return;
      this.usageError = sanitizeDiagnosticError(
        error instanceof Error ? error.message : String(error),
      );
      try {
        this.updateFooter(ctx);
        if (options?.notify) ctx.ui.notify(this.formatStatus(ctx), "warning");
      } catch (secondaryError) {
        if (!this.handleStaleContextError(secondaryError, generation)) {
          this.usageError = sanitizeDiagnosticError(
            secondaryError instanceof Error ? secondaryError.message : String(secondaryError),
          );
        }
      }
    } finally {
      this.usageAbortController = undefined;
      this.usageRefreshInFlight = false;
      const next = this.queuedUsageRefresh;
      this.queuedUsageRefresh = undefined;
      if (next && !this.shuttingDown && next.generation === this.sessionGeneration) {
        void this.refresh(next.ctx, { notify: next.notify, force: next.force }, next.generation);
      }
    }
  }

  private stopTimer(): void {
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = undefined;
    if (this.sessionAbortSignal && this.sessionAbortHandler) {
      this.sessionAbortSignal.removeEventListener("abort", this.sessionAbortHandler);
    }
    this.sessionAbortSignal = undefined;
    this.sessionAbortHandler = undefined;
  }

  start(ctx: ExtensionContext): void {
    this.usageAbortController?.abort();
    this.queuedUsageRefresh = undefined;
    this.stopTimer();
    const generation = ++this.sessionGeneration;
    this.shuttingDown = false;

    const cfg = this.getConfig(ctx);
    if (!cfg.usage.enabled) return;
    const sessionSignal = ctx.signal;
    if (sessionSignal?.aborted) {
      this.deactivateGeneration(generation);
      return;
    }
    this.sessionAbortSignal = sessionSignal;
    this.sessionAbortHandler = () => {
      this.deactivateGeneration(generation);
    };
    sessionSignal?.addEventListener("abort", this.sessionAbortHandler, { once: true });
    void this.refresh(ctx, { force: true }, generation);
    this.usageTimer = setInterval(() => {
      if (!this.isGenerationCurrent(generation)) return;
      if (sessionSignal?.aborted) {
        this.deactivateGeneration(generation);
        return;
      }
      void this.refresh(ctx, undefined, generation);
    }, cfg.usage.refreshIntervalMs);
    this.usageTimer.unref?.();
  }

  restartAfterSettingsChange(ctx: ExtensionContext, cfg: ResolvedConfig): void {
    this.usageAbortController?.abort();
    this.queuedUsageRefresh = undefined;
    this.stopTimer();
    this.sessionGeneration++;
    this.shuttingDown = false;
    if (cfg.usage.enabled) this.start(ctx);
    else {
      this.usageSnapshot = undefined;
      this.usageError = "Usage display is disabled.";
    }
  }

  shutdown(): void {
    this.shuttingDown = true;
    this.sessionGeneration++;
    this.queuedUsageRefresh = undefined;
    this.usageAbortController?.abort();
    this.usageAbortController = undefined;
    this.stopTimer();
  }
}
