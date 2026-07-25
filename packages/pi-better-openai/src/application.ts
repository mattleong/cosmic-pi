/** Better OpenAI, implemented as one Effect-managed runtime per Pi session. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import {
  captureSessionHost,
  hasTerminalUI,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { createCosmicFooterClient } from "pi-cosmic-ui/client";
import { ignoreHostUi, safeHostSignal, safeHostUi } from "./boundary/host-ui.ts";
import { decodeOpenAICompactionDetails } from "./compaction/protocol.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import {
  CONFIG_BASENAME,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  configPaths,
  type OpenAIConfigError,
  type ResolvedConfig,
} from "./config/index.ts";
import {
  fastDebugLines,
  fastStateText,
  inactiveForModelMessage,
  initialFastSnapshot,
  injectProviderPayload,
  isFastActive,
  supportsFast,
  unsupportedRequestMessage,
} from "./fast/controller.ts";
import { FastModeService } from "./fast/service.ts";
import { FAST_SERVICE_TIER, SUPPORTED_FAST_MODELS } from "./fast/models.ts";
import {
  makeOpenAIApplicationLayer,
  type OpenAIApplication,
  type OpenAIRuntimeError,
  type OpenAISessionInput,
} from "./layer.ts";
import { abbreviateHomePath, createFooterController } from "./footer/controller.ts";
import { registerOpenAIImage, _imageTest } from "./image/index.ts";
import { registerSettingsController } from "./settings/controller.ts";
import {
  fastModeFooterPrimitive,
  fastModeUiState,
  openAIUsageFooterPrimitive,
  openAIUsageUiState,
} from "./ui/primitives.ts";
import {
  OpenAIBoundaryError,
  OpenAIUsageService,
  formatDebug,
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
  type OpenAIProjection,
} from "./usage/index.ts";
import { formatPercent, formatUsageSnapshot, parseUsageSnapshot } from "./usage/index.ts";

const FAST_ID = "fast";

export interface BetterOpenAIExtensionDependencies {
  readonly startupEffect: (generation: number) => Effect.Effect<void, never, OpenAIUsageService>;
}

const captureSessionHostContext = (ctx: ExtensionContext) => {
  const captured = captureSessionHost(ctx);
  if (captured._tag === "Captured") {
    return {
      _tag: "Success" as const,
      value: { cwd: captured.cwd, signal: captured.signal, aborted: captured.aborted },
    };
  }
  return {
    _tag: "Failure" as const,
    error: new OpenAIBoundaryError({
      operation: "session-context",
      message: "Unable to capture the Pi session context.",
    }),
  };
};
const requiredConfig = (projection: MutableRef.MutableRef<OpenAIProjection>): ResolvedConfig => {
  const cfg = MutableRef.get(projection).config;
  if (cfg) return cfg;
  throw new OpenAIBoundaryError({
    operation: "config",
    message: "Better OpenAI session has not started.",
  });
};

export function registerBetterOpenAIApplication(pi: ExtensionAPI): void {
  betterOpenAIWithDependencies(pi, {
    startupEffect: () => OpenAIUsageService.use(() => Effect.void),
  });
}

/** Internal seam for deterministic lifecycle/finalizer tests. */
export function betterOpenAIWithDependencies(
  pi: ExtensionAPI,
  dependencies: BetterOpenAIExtensionDependencies,
): void {
  const projection = makeProjection();
  const fastProjection = MutableRef.make(initialFastSnapshot());
  let recordFastInjection: (event: {
    readonly model: string;
    readonly tier: string;
  }) => void = () => undefined;
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-openai");
  const config = (_ctx: ExtensionContext) => requiredConfig(projection);
  const updateCosmicUi = (ctx: ExtensionContext, cfg: ResolvedConfig) => {
    if (!cosmicUi.active) return;
    const fast = fastModeFooterPrimitive(fastModeUiState(ctx, MutableRef.get(fastProjection)));
    const usage = openAIUsageFooterPrimitive(openAIUsageUiState(ctx, cfg, projection));
    if (fast) cosmicUi.upsert(fast);
    else cosmicUi.remove("openai.fast");
    if (usage) cosmicUi.upsert(usage);
    else cosmicUi.remove("openai.usage");
  };
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(projection).config;
    if (!cfg) return;
    if (cosmicUi.active) updateCosmicUi(ctx, cfg);
    else footerController.update(ctx);
  };
  const footerController = createFooterController({
    pi,
    config,
    fastProjection,
    projection,
    hasTerminalUI,
  });

  let startGeneration = 0;
  let sessionActive = false;
  const slot = makePiSessionRuntimeSlot<
    OpenAISessionInput,
    OpenAIApplication,
    OpenAIConfigError,
    OpenAIRuntimeError
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeOpenAIApplicationLayer(input, {
          projection,
          fastProjection,
          onUsageChange: (context) => {
            if (sessionActive) updateFooter(MutableRef.get(context));
          },
          registerFastInjectionIngress: (offer) => {
            recordFastInjection = offer;
          },
        }),
        { agentDirectory: getAgentDir, packageName: "pi-better-openai" },
      ),
    startup: ({ ctx, generation }) =>
      dependencies
        .startupEffect(generation)
        .pipe(
          Effect.andThen(
            FastModeService.use((service) =>
              service.initialize(ctx, config(ctx), pi.getFlag(FAST_ID) === true),
            ),
          ),
        ),
    onActivated: ({ ctx }) => {
      sessionActive = true;
      if (hasTerminalUI(ctx)) cosmicUi.query();
      else cosmicUi.shutdown();
      footerController.refreshTotals(ctx);
      updateFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive && !isFastActive(ctx, fast))
        safeHostUi(() => ctx.ui.notify(unsupportedRequestMessage(ctx), "warning"));
      if (isFastActive(ctx, fast))
        safeHostUi(() => ctx.ui.notify(fastStateText(ctx, fast), "info"));
    },
    onDeactivated: ({ context }) => {
      sessionActive = false;
      if (currentContext === context) currentContext = undefined;
      cosmicUi.shutdown();
      resetProjection(projection);
      MutableRef.set(fastProjection, initialFastSnapshot());
    },
    onStartFailure: ({ ctx }) => {
      safeHostUi(() => ctx.ui.notify("Better OpenAI failed to start.", "warning"));
    },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, OpenAIApplication>, signal?: AbortSignal) =>
    sessionActive
      ? slot.run(effect, signal)
      : Promise.reject(
          new OpenAIBoundaryError({
            operation: "runtime",
            message: "Better OpenAI session has not started.",
          }),
        );

  pi.registerFlag(FAST_ID, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
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
      return run(
        FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* ignoreHostUi("fast.render", () => updateFooter(ctx));
              const fast = MutableRef.get(fastProjection);
              const active = isFastActive(ctx, fast);
              yield* ignoreHostUi("fast.notify", () =>
                ctx.ui.notify(
                  fast.desiredActive && !active
                    ? unsupportedRequestMessage(ctx)
                    : fastStateText(ctx, fast),
                  fast.desiredActive && !active ? "warning" : "info",
                ),
              );
            }),
          ),
        ),
        safeHostSignal(ctx),
      );
    },
  });
  pi.registerCommand("openai-usage", {
    description: "Show OpenAI subscription usage status",
    handler: (_args, ctx) => {
      updateContext(ctx);
      return run(
        OpenAIUsageService.use((service) => service.refresh({ notify: true, force: true })),
        safeHostSignal(ctx),
      ).catch(() => {
        safeHostUi(() => ctx.ui.notify("OpenAI usage is unavailable.", "warning"));
      });
    },
  });
  const formatDebugStatus = (ctx: ExtensionContext) => {
    const cfg = config(ctx);
    return [
      ...fastDebugLines(ctx, MutableRef.get(fastProjection), FAST_SERVICE_TIER),
      `Footer mode: ${cfg.footer.mode}`,
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
    run,
  });
  registerOpenAIImage(pi, run, updateContext);

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSessionHostContext(ctx);
    if (captured._tag === "Failure") {
      safeHostUi(() => ctx.ui.notify("Better OpenAI failed to start.", "warning"));
      return slot.shutdown();
    }
    const { cwd, signal, aborted } = captured.value;
    if (aborted) {
      safeHostUi(() => ctx.ui.notify("Better OpenAI failed to start.", "warning"));
      return slot.shutdown();
    }
    const projectTrusted = isProjectTrusted(ctx);
    cosmicUi.shutdown();
    resetProjection(projection);
    MutableRef.set(fastProjection, initialFastSnapshot());
    footerController.resetTotals();
    footerController.invalidateContextUsage();
    footerController.invalidateSessionName();
    const context = MutableRef.make(ctx);
    currentContext = context;
    return slot
      .start(
        {
          ctx,
          context,
          cwd,
          generation: ++startGeneration,
          projectTrusted,
        },
        signal,
      )
      .then(() => undefined);
  });
  pi.on("agent_start", (_event, ctx) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
    updateFooter(ctx);
  });
  pi.on("turn_end", (event, ctx) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
    if (event.message?.role === "assistant")
      footerController.addAssistantUsage(event.message.usage);
    else footerController.refreshTotals(ctx);
    updateFooter(ctx);
    slot.fork(
      OpenAIUsageService.use((service) => service.refresh()),
      safeHostSignal(ctx),
    );
  });
  const refreshFooter = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
    footerController.refreshTotals(ctx);
    updateFooter(ctx);
  };
  pi.on("session_before_compact", (event, ctx) => {
    updateContext(ctx);
    if (!sessionActive) return undefined;
    return run(
      OpenAICompactionService.use((service) => service.compact(event)),
      event.signal,
    )
      .then((compaction) => {
        if (!compaction) return undefined;
        return { compaction };
      })
      .catch(() => {
        if (!event.signal.aborted)
          safeHostUi(() =>
            ctx.ui.notify("OpenAI compaction failed; using Pi compaction.", "warning"),
          );
        return undefined;
      });
  });
  pi.on("session_compact", (event, ctx) => {
    refreshFooter(ctx);
    if (event.fromExtension && decodeOpenAICompactionDetails(event.compactionEntry.details))
      safeHostUi(() => ctx.ui.notify("Context compacted using OpenAI.", "info"));
  });
  pi.on("session_tree", (_event, ctx) => refreshFooter(ctx));
  pi.on("model_select", (_event, ctx) => {
    const signal = safeHostSignal(ctx);
    const before = MutableRef.get(fastProjection).active;
    updateContext(ctx);
    footerController.invalidateContextUsage();
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
    footerController.invalidateContextUsage();
    footerController.invalidateSessionName();
    return slot.shutdown();
  });
  pi.on("context", (event, ctx) => {
    updateContext(ctx);
    if (!sessionActive) return undefined;
    return run(
      OpenAICompactionService.use((service) => service.filterContext(event.messages)),
      safeHostSignal(ctx),
    )
      .then((messages) => (messages ? { messages } : undefined))
      .catch(() => undefined);
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
    if (!sessionActive) return fastPayload;
    return run(
      OpenAICompactionService.use((service) => service.inject(fastPayload ?? event.payload)),
      safeHostSignal(ctx),
    )
      .then((compactedPayload) => compactedPayload ?? fastPayload)
      .catch(() => fastPayload);
  });
  const invalidateContextUsage = (_event: unknown, ctx: ExtensionContext) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
  };
  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", invalidateContextUsage);
  pi.on("message_end", invalidateContextUsage);
}

export const _test = {
  CONFIG_BASENAME,
  SUPPORTED_FAST_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  SERVICE_TIER: FAST_SERVICE_TIER,
  configPaths,
  abbreviateHomePath,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  imageTest: _imageTest,
};
