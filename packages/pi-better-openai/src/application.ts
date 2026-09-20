/** Better OpenAI, implemented as one Effect-managed runtime per Pi session. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import {
  loadCodePreviewSettings,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  hasTerminalUI,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  sanitizeDiagnosticError,
} from "pi-cosmic-core";
import { createCosmicFooterClient } from "pi-cosmic-ui/client";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import {
  applyFastRoutingHeaders,
  resetOpenAICodexTransport,
} from "./boundary/host-provider-routing.ts";
import { ignoreHostUi, safeHostSignal, safeHostUi } from "./boundary/host-ui.ts";
import { latestOwnedCompaction } from "./compaction/context.ts";
import { decodeOpenAICompactionDetails } from "./compaction/protocol.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import type { ResolvedConfig } from "./config/schema.ts";
import type { OpenAIConfigError } from "./config/store.ts";
import {
  fastDebugLines,
  fastStateText,
  inactiveForModelMessage,
  initialFastSnapshot,
  injectProviderPayload,
  isFastActive,
  statusSegment,
  unsupportedRequestMessage,
} from "./fast/controller.ts";
import { FastModeService, type FastInjectionIngress } from "./fast/service.ts";
import { FAST_SERVICE_TIER } from "./fast/models.ts";
import {
  makeOpenAIApplicationLayer,
  type OpenAIApplication,
  type OpenAIRuntimeError,
  type OpenAISessionInput,
} from "./layer.ts";
import { registerOpenAIImage } from "./image/register.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { fastModeFooterPrimitive, openAIUsageFooterPrimitive } from "./ui/primitives.ts";
import { OpenAIBoundaryError, OpenAIUsageService } from "./usage/controller.ts";
import { formatDebug } from "./usage/debug.ts";
import {
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
  type OpenAIProjection,
} from "./usage/projection.ts";

const FAST_ID = "fast";

export interface BetterOpenAIExtensionDependencies {
  readonly loadPreviewSettings?: (
    projectCwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly resetOpenAICodexTransport?: (ctx: ExtensionContext) => void;
}

const requiredConfig = (projection: MutableRef.MutableRef<OpenAIProjection>): ResolvedConfig => {
  const cfg = MutableRef.get(projection).config;
  if (cfg) return cfg;
  throw new OpenAIBoundaryError({
    operation: "config",
    message: "Better OpenAI session has not started.",
  });
};

export function registerBetterOpenAIApplication(pi: ExtensionAPI): void {
  betterOpenAIWithDependencies(pi, {});
}

/** Internal seam for deterministic lifecycle/finalizer tests. */
export function betterOpenAIWithDependencies(
  pi: ExtensionAPI,
  dependencies: BetterOpenAIExtensionDependencies,
): void {
  const projection = makeProjection();
  const fastProjection = MutableRef.make(initialFastSnapshot());
  const resetProviderTransport =
    dependencies.resetOpenAICodexTransport ?? resetOpenAICodexTransport;
  const loadPreviewSettings = dependencies.loadPreviewSettings ?? loadCodePreviewSettings;
  let recordFastInjection: FastInjectionIngress = () => undefined;
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-openai");
  const config = (_ctx: ExtensionContext) => requiredConfig(projection);
  const setStatus = makeSetStatusSafely("better-openai");
  let usageVisible = true;
  const isUsageVisible = () => {
    cosmicUi.query();
    return cosmicUi.isVisible("openai.usage");
  };
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(projection).config;
    if (!cfg) return;
    cosmicUi.query();
    const nextUsageVisible = cosmicUi.isVisible("openai.usage");
    const fast = cosmicUi.isVisible("openai.fast")
      ? fastModeFooterPrimitive(ctx, MutableRef.get(fastProjection))
      : undefined;
    const usage = nextUsageVisible ? openAIUsageFooterPrimitive(ctx, cfg, projection) : undefined;
    if (hasTerminalUI(ctx) && cosmicUi.installed) {
      if (fast) cosmicUi.upsert(fast);
      else cosmicUi.remove("openai.fast");
      if (usage) cosmicUi.upsert(usage);
      else cosmicUi.remove("openai.usage");
    }
    setStatus(
      ctx,
      hasTerminalUI(ctx) && cosmicUi.active
        ? undefined
        : [fast ? statusSegment(ctx, MutableRef.get(fastProjection)) : undefined, usage?.text]
            .filter(Boolean)
            .join(" | ") || undefined,
    );
    if (usageVisible !== nextUsageVisible) {
      usageVisible = nextUsageVisible;
      slot.fork(
        OpenAIUsageService.use((service) =>
          service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
        ),
      );
    }
  };
  let stopCosmicUiChanges: (() => void) | undefined;
  const watchCosmicUi = () => {
    if (stopCosmicUiChanges) return;
    stopCosmicUiChanges = cosmicUi.onHostStateChange(() => {
      if (currentContext) updateFooter(MutableRef.get(currentContext));
    });
  };
  const stopWatchingCosmicUi = () => {
    stopCosmicUiChanges?.();
    stopCosmicUiChanges = undefined;
  };

  const slot = makePiSessionRuntimeSlot<
    OpenAISessionInput,
    OpenAIApplication,
    OpenAIConfigError,
    OpenAIRuntimeError,
    {
      readonly injectionIngress: FastInjectionIngress;
      readonly scheduler: CodePreviewSchedulerServiceContract;
    }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        Layer.merge(
          makeOpenAIApplicationLayer(input, {
            projection,
            fastProjection,
            isUsageVisible,
            onUsageChange: (context) => {
              if (currentContext === context) updateFooter(MutableRef.get(context));
            },
          }),
          CodePreviewSchedulerService.layer,
        ),
        { agentDirectory: getAgentDir, packageName: "pi-better-openai" },
      ),
    startup: ({ ctx, cwd, projectTrusted }) =>
      bestEffortHostBootstrap("pi-better-openai.preview-settings", (signal) =>
        loadPreviewSettings(cwd, projectTrusted, signal),
      ).pipe(
        Effect.andThen(
          FastModeService.use((service) =>
            service
              .initialize(ctx, config(ctx), pi.getFlag(FAST_ID) === true)
              .pipe(Effect.as(service.recordInjection)),
          ),
        ),
        Effect.flatMap((injectionIngress) =>
          CodePreviewSchedulerService.pipe(
            Effect.map((scheduler) => ({ injectionIngress, scheduler })),
          ),
        ),
      ),
    onActivated: ({ ctx, context }, token, { injectionIngress, scheduler }) => {
      currentContext = context;
      recordFastInjection = injectionIngress;
      registerOpenAIImage(pi, run, updateContext, (intervalMs, tick) =>
        currentContext === context && slot.isCurrent(token)
          ? scheduler.schedule(intervalMs, tick)
          : undefined,
      );
      watchCosmicUi();
      updateFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive && !isFastActive(ctx, fast))
        safeHostUi(() => ctx.ui.notify(unsupportedRequestMessage(ctx), "warning"));
      if (isFastActive(ctx, fast))
        safeHostUi(() => ctx.ui.notify(fastStateText(ctx, fast), "info"));
    },
    onDeactivated: ({ context }) => {
      if (currentContext === context) {
        setStatus(MutableRef.get(context), undefined);
        currentContext = undefined;
      }
      stopWatchingCosmicUi();
      recordFastInjection = () => undefined;
      cosmicUi.shutdown();
      resetProjection(projection);
      MutableRef.set(fastProjection, initialFastSnapshot());
    },
    onStartFailure: ({ ctx }) => {
      safeHostUi(() => ctx.ui.notify("Better OpenAI failed to start.", "warning"));
    },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, OpenAIApplication>, signal?: AbortSignal) =>
    slot.isActive()
      ? slot.run(effect, signal)
      : Promise.reject(
          new OpenAIBoundaryError({
            operation: "runtime",
            message: "Better OpenAI session has not started.",
          }),
        );
  const containCommandFailure = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    operation: string,
    ctx: ExtensionContext,
    typedMessage: (error: E) => string,
  ): Effect.Effect<A | void, never, R> =>
    effect.pipe(
      Effect.catch((error) => ignoreHostUi(() => ctx.ui.notify(typedMessage(error), "warning"))),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`Better OpenAI ${operation} raised an unexpected defect.`).pipe(
              Effect.andThen(
                ignoreHostUi(() =>
                  ctx.ui.notify(`OpenAI ${operation} failed unexpectedly.`, "warning"),
                ),
              ),
            ),
      ),
    );

  pi.registerFlag(FAST_ID, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });
  const runHostCommand = <A>(
    effect: Effect.Effect<A, { readonly message: string }, OpenAIApplication>,
    operation: "fast mode" | "usage",
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ) =>
    run(
      containCommandFailure(
        effect,
        operation,
        ctx,
        (error) => `OpenAI ${operation} is unavailable: ${sanitizeDiagnosticError(error.message)}.`,
      ),
      signal,
    ).catch(() => {
      if (!signal?.aborted)
        safeHostUi(() => ctx.ui.notify(`OpenAI ${operation} is unavailable.`, "warning"));
    });

  pi.registerCommand(FAST_ID, {
    description: "Toggle OpenAI fast mode",
    handler: (args, ctx) => {
      updateContext(ctx);
      if (args.trim()) {
        safeHostUi(() => ctx.ui.notify("Usage: /fast", "error"));
        return Promise.resolve();
      }
      const desired = !MutableRef.get(fastProjection).desiredActive;
      const signal = safeHostSignal(ctx);
      const update = FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            yield* Effect.sync(() => resetProviderTransport(ctx));
            yield* ignoreHostUi(() => updateFooter(ctx));
            const fast = MutableRef.get(fastProjection);
            const active = isFastActive(ctx, fast);
            yield* ignoreHostUi(() =>
              ctx.ui.notify(
                fast.desiredActive && !active
                  ? unsupportedRequestMessage(ctx)
                  : fastStateText(ctx, fast),
                fast.desiredActive && !active ? "warning" : "info",
              ),
            );
          }),
        ),
      );
      return runHostCommand(update, "fast mode", ctx, signal);
    },
  });
  pi.registerCommand("openai-usage", {
    description: "Show OpenAI subscription usage status",
    handler: (_args, ctx) => {
      updateContext(ctx);
      const signal = safeHostSignal(ctx);
      const refresh = OpenAIUsageService.use((service) =>
        service.refresh({ notify: true, force: true }),
      );
      return runHostCommand(refresh, "usage", ctx, signal);
    },
  });
  const formatDebugStatus = (ctx: ExtensionContext) => {
    const cfg = config(ctx);
    return [
      ...fastDebugLines(ctx, MutableRef.get(fastProjection), FAST_SERVICE_TIER),
      `Footer usage: ${cosmicUi.isVisible("openai.usage") ? "automatic" : "hidden"} (Cosmic UI)`,
      `OpenAI compaction: ${cfg.compaction.enabled ? "enabled" : "disabled"}`,
      "",
      formatDebug(projection, ctx),
      "",
      `Image enabled: ${cfg.image.enabled}`,
      `Image default save: ${cfg.image.defaultSave}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  };
  registerSettingsController(pi, {
    config,
    updateContext,
    updateFooter,
    hasTerminalUI,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport: resetProviderTransport,
    run,
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSessionHost(ctx);
    if (captured._tag !== "Captured" || captured.aborted) {
      safeHostUi(() => ctx.ui.notify("Better OpenAI failed to start.", "warning"));
      return slot.shutdown();
    }
    const { cwd, signal } = captured;
    const projectTrusted = isProjectTrusted(ctx);
    resetProviderTransport(ctx);
    cosmicUi.shutdown();
    resetProjection(projection);
    MutableRef.set(fastProjection, initialFastSnapshot());
    const context = MutableRef.make(ctx);
    return slot
      .start(
        {
          ctx,
          context,
          cwd,
          projectTrusted,
        },
        signal,
      )
      .then(() => undefined);
  });
  pi.on("agent_start", (_event, ctx) => {
    updateContext(ctx);
    updateFooter(ctx);
  });
  pi.on("turn_end", (_event, ctx) => {
    updateContext(ctx);
    updateFooter(ctx);
    slot.fork(
      OpenAIUsageService.use((service) => service.refresh()),
      safeHostSignal(ctx),
    );
  });
  const refreshFooter = (ctx: ExtensionContext) => {
    updateContext(ctx);
    updateFooter(ctx);
  };
  const needsContextRepair = (ctx: ExtensionContext) => {
    try {
      return Boolean(latestOwnedCompaction(ctx.sessionManager.getBranch()));
    } catch {
      return true;
    }
  };
  const abortIncompleteContext = (ctx: ExtensionContext) => {
    // Pi contains extension exceptions. Aborting the run is required to fail closed.
    safeHostUi(() => ctx.abort());
    safeHostUi(() =>
      ctx.ui.notify("Unable to restore the complete conversation; request cancelled.", "warning"),
    );
  };
  pi.on("session_before_compact", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) return needsContextRepair(ctx) ? { cancel: true } : undefined;
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.compact(event)),
          event.signal,
        ),
      )
      .then((compaction) => {
        if (!compaction) return undefined;
        return { compaction };
      })
      .catch(() => {
        const cancel = event.signal.aborted || needsContextRepair(ctx);
        if (!event.signal.aborted)
          safeHostUi(() =>
            ctx.ui.notify(
              cancel
                ? "Compaction cancelled to preserve the complete conversation."
                : "OpenAI compaction failed; using Pi compaction.",
              "warning",
            ),
          );
        return cancel ? { cancel: true } : undefined;
      });
  });
  pi.on("session_compact", (event, ctx) => {
    refreshFooter(ctx);
    if (event.fromExtension && decodeOpenAICompactionDetails(event.compactionEntry.details))
      safeHostUi(() => ctx.ui.notify("Context compacted using OpenAI.", "info"));
  });
  pi.on("session_tree", (_event, ctx) => {
    refreshFooter(ctx);
    if (!currentContext) return undefined;
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.resetRetryOmissions()),
          safeHostSignal(ctx),
        ),
      )
      .catch(() => undefined);
  });
  pi.on("model_select", (_event, ctx) => {
    const signal = safeHostSignal(ctx);
    resetProviderTransport(ctx);
    const before = MutableRef.get(fastProjection).active;
    updateContext(ctx);
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    const fast = MutableRef.get(fastProjection);
    const active = isFastActive(ctx, fast);
    if (active !== before)
      safeHostUi(() =>
        ctx.ui.notify(
          active ? fastStateText(ctx, fast) : inactiveForModelMessage(ctx),
          active ? "info" : "warning",
        ),
      );
    slot.fork(
      FastModeService.use((service) => service.modelChanged(ctx)),
      signal,
    );
    slot.fork(
      OpenAIUsageService.use((service) =>
        service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
      ),
      signal,
    );
  });
  pi.on("session_shutdown", () => {
    cosmicUi.shutdown();
    return slot.shutdown();
  });
  pi.on("context", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) {
      if (needsContextRepair(ctx)) abortIncompleteContext(ctx);
      return undefined;
    }
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.filterContext(event.messages)),
          safeHostSignal(ctx),
        ),
      )
      .then((messages) => (messages ? { messages } : undefined))
      .catch(() => {
        if (needsContextRepair(ctx)) abortIncompleteContext(ctx);
        return undefined;
      });
  });
  pi.on("before_provider_headers", (event, ctx) => {
    updateContext(ctx);
    applyFastRoutingHeaders(event.headers, ctx, MutableRef.get(fastProjection), FAST_SERVICE_TIER);
  });
  pi.on("before_provider_request", (event, ctx) => {
    updateContext(ctx);
    const fastPayload = injectProviderPayload(
      event,
      ctx,
      MutableRef.get(fastProjection),
      FAST_SERVICE_TIER,
      recordFastInjection,
    );
    if (!currentContext) return fastPayload;
    return run(
      OpenAICompactionService.use((service) => service.inject(fastPayload ?? event.payload)),
      safeHostSignal(ctx),
    )
      .then((compactedPayload) => compactedPayload ?? fastPayload)
      .catch(() => fastPayload);
  });
}
