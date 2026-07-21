/** Better OpenAI, implemented as one Effect-managed runtime per Pi session. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import {
  AgentDirectory,
  SafeFile,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  nodePlatformLayer,
} from "pi-cosmic-core";
import { SharpAdapter } from "./boundary/sharp.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  configPaths,
  type OpenAIConfigError,
  type ResolvedConfig,
} from "./config.ts";
import {
  fastDebugLines,
  fastStateText,
  inactiveForModelMessage,
  initialFastSnapshot,
  injectProviderPayload,
  isFastActive,
  supportsFast,
  unsupportedRequestMessage,
} from "./fast-controller.ts";
import { FastModeService } from "./fast-service.ts";
import { FAST_SERVICE_TIER, SUPPORTED_FAST_MODELS } from "./fast-models.ts";
import { createFooterController, type FooterController } from "./footer/controller.ts";
import { abbreviateHomePath } from "./footer-layout.ts";
import { registerOpenAIImage, OpenAIImageService, _imageTest } from "./image.ts";
import { CONFIG_BASENAME } from "./identity.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { createCosmicUiAdapter, type CosmicUiAdapter } from "./ui/cosmic-adapter.ts";
import {
  OpenAIBoundaryError,
  OpenAIUsageService,
  formatDebug,
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
  type OpenAIProjection,
} from "./usage-controller.ts";
import { formatPercent, formatUsageSnapshot, parseUsageSnapshot } from "./usage.ts";

const COMMAND = "fast";
const OPENAI_STATUS_COMMAND = "openai-usage";
const FLAG = "fast";
const SERVICE_TIER = FAST_SERVICE_TIER;

export interface BetterOpenAIExtensionDependencies {
  readonly startupEffect: (generation: number) => Effect.Effect<void, never, OpenAIUsageService>;
}

const defaultDependencies: BetterOpenAIExtensionDependencies = {
  startupEffect: () => OpenAIUsageService.use(() => Effect.void),
};

const hasTerminalUI = (ctx: ExtensionContext) =>
  ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
const isProjectTrusted = (ctx: ExtensionContext): boolean => {
  try {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  } catch {
    return false;
  }
};
const requiredConfig = (projection: MutableRef.MutableRef<OpenAIProjection>): ResolvedConfig => {
  const cfg = MutableRef.get(projection).config;
  if (cfg) return cfg;
  throw new OpenAIBoundaryError({
    operation: "config",
    message: "Better OpenAI session has not started.",
  });
};

export default function betterOpenAI(pi: ExtensionAPI): void {
  betterOpenAIWithDependencies(pi, defaultDependencies);
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
  let footerController: FooterController;
  let cosmicUiAdapter: CosmicUiAdapter;
  const config = (_ctx: ExtensionContext) => requiredConfig(projection);
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(projection).config;
    if (!cfg) return;
    if (cosmicUiAdapter.active) cosmicUiAdapter.update(ctx, cfg);
    else footerController.update(ctx);
  };
  footerController = createFooterController({
    pi,
    config,
    fastProjection,
    projection,
    hasTerminalUI,
  });
  cosmicUiAdapter = createCosmicUiAdapter({ pi, fastProjection, projection });

  let startGeneration = 0;
  let sessionActive = false;
  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly generation: number;
    readonly projectTrusted: boolean;
  };
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    OpenAIUsageService | OpenAIImageService | FastModeService,
    OpenAIConfigError
  >({
    makeRuntime: ({ ctx, context, projectTrusted }) => {
      const usage = OpenAIUsageService.layer({
        context,
        cwd: ctx.cwd,
        projection,
        projectTrusted,
        onChange: () => {
          if (sessionActive) updateFooter(MutableRef.get(context));
        },
      });
      const fast = FastModeService.layer({
        serviceTier: SERVICE_TIER,
        projection: fastProjection,
        registerInjectionIngress: (offer) => {
          recordFastInjection = offer;
        },
      }).pipe(Layer.provide(usage));
      const image = OpenAIImageService.layer({ context, projection }).pipe(
        Layer.provide(Layer.merge(SharpAdapter.layer, SafeFile.layer)),
      );
      const platform = Layer.merge(
        nodePlatformLayer,
        AgentDirectory.layerFromHost(() => getAgentDir()),
      );
      return makePiManagedRuntime(
        pi,
        Layer.mergeAll(usage, fast, image).pipe(Layer.provide(platform)),
      );
    },
    startup: ({ ctx, generation }) =>
      dependencies
        .startupEffect(generation)
        .pipe(
          Effect.andThen(
            FastModeService.use((service) =>
              service.initialize(ctx, config(ctx), pi.getFlag(FLAG) === true),
            ),
          ),
        ),
    onActivated: ({ ctx }) => {
      sessionActive = true;
      if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
      else cosmicUiAdapter.shutdown();
      footerController.refreshTotals(ctx);
      updateFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive && !isFastActive(ctx, fast))
        ctx.ui.notify(unsupportedRequestMessage(ctx), "warning");
      if (isFastActive(ctx, fast)) ctx.ui.notify(fastStateText(ctx, fast), "info");
    },
    onDeactivated: () => {
      sessionActive = false;
      currentContext = undefined;
      cosmicUiAdapter.shutdown();
      resetProjection(projection);
      MutableRef.set(fastProjection, initialFastSnapshot());
    },
    onStartFailure: ({ ctx }) => {
      try {
        ctx.ui.notify("Better OpenAI failed to start.", "warning");
      } catch {
        // Host notification failures do not prevent runtime cleanup.
      }
    },
  });
  const run = <A, E>(
    effect: Effect.Effect<A, E, OpenAIUsageService | OpenAIImageService | FastModeService>,
    signal?: AbortSignal,
  ) =>
    sessionActive
      ? slot.run(effect, signal)
      : Promise.reject(
          new OpenAIBoundaryError({
            operation: "runtime",
            message: "Better OpenAI session has not started.",
          }),
        );

  pi.registerFlag(FLAG, {
    description: "Start with OpenAI fast mode enabled (service_tier=priority)",
    type: "boolean",
    default: false,
  });
  pi.registerCommand(COMMAND, {
    description: "Toggle OpenAI fast mode",
    handler: (args, ctx) => {
      updateContext(ctx);
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast", "error");
        return Promise.resolve();
      }
      const desired = !MutableRef.get(fastProjection).desiredActive;
      return run(
        FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              updateFooter(ctx);
              const fast = MutableRef.get(fastProjection);
              const active = isFastActive(ctx, fast);
              ctx.ui.notify(
                fast.desiredActive && !active
                  ? unsupportedRequestMessage(ctx)
                  : fastStateText(ctx, fast),
                fast.desiredActive && !active ? "warning" : "info",
              );
            }),
          ),
        ),
        ctx.signal,
      );
    },
  });
  pi.registerCommand(OPENAI_STATUS_COMMAND, {
    description: "Show OpenAI subscription usage status",
    handler: (_args, ctx) => {
      updateContext(ctx);
      return run(
        OpenAIUsageService.use((service) => service.refresh({ notify: true, force: true })),
        ctx.signal,
      ).catch(() => ctx.ui.notify("OpenAI usage is unavailable.", "warning"));
    },
  });
  const formatDebugStatus = (ctx: ExtensionContext) => {
    const cfg = config(ctx);
    return [
      ...fastDebugLines(ctx, MutableRef.get(fastProjection), SERVICE_TIER),
      `Footer mode: ${cfg.footer.mode}`,
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
    cosmicUiAdapter.shutdown();
    resetProjection(projection);
    MutableRef.set(fastProjection, initialFastSnapshot());
    footerController.invalidateContextUsage();
    footerController.invalidateSessionName();
    const context = MutableRef.make(ctx);
    currentContext = context;
    if (ctx.signal?.aborted) {
      try {
        ctx.ui.notify("Better OpenAI failed to start.", "warning");
      } catch {
        // Host notification failures do not prevent runtime cleanup.
      }
    }
    return slot
      .start(
        { ctx, context, generation: ++startGeneration, projectTrusted: isProjectTrusted(ctx) },
        ctx.signal,
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
      ctx.signal,
    );
  });
  const refreshFooter = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
    footerController.refreshTotals(ctx);
    updateFooter(ctx);
  };
  pi.on("session_compact", (_event, ctx) => refreshFooter(ctx));
  pi.on("session_tree", (_event, ctx) => refreshFooter(ctx));
  pi.on("model_select", (_event, ctx) => {
    const before = MutableRef.get(fastProjection).active;
    updateContext(ctx);
    footerController.invalidateContextUsage();
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    const fast = MutableRef.get(fastProjection);
    const active = isFastActive(ctx, fast);
    if (active !== before)
      ctx.ui.notify(
        active ? fastStateText(ctx, fast) : inactiveForModelMessage(ctx),
        active ? "info" : "warning",
      );
    slot.fork(
      FastModeService.use((service) => service.modelChanged(ctx)),
      ctx.signal,
    );
    slot.fork(
      OpenAIUsageService.use((service) =>
        service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
      ),
      ctx.signal,
    );
  });
  pi.on("session_shutdown", () => {
    cosmicUiAdapter.shutdown();
    footerController.invalidateContextUsage();
    footerController.invalidateSessionName();
    return slot.shutdown();
  });
  pi.on("before_provider_request", (event, ctx) => {
    updateContext(ctx);
    return injectProviderPayload(
      event,
      ctx,
      MutableRef.get(fastProjection),
      SERVICE_TIER,
      recordFastInjection,
    );
  });
  pi.on("message_start", (_event, ctx) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
  });
  pi.on("message_update", (_event, ctx) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
  });
  pi.on("message_end", (_event, ctx) => {
    updateContext(ctx);
    footerController.invalidateContextUsage();
  });
}

export const _test = {
  CONFIG_BASENAME,
  SUPPORTED_FAST_MODELS,
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  SERVICE_TIER,
  configPaths,
  abbreviateHomePath,
  supportsFast,
  parseUsageSnapshot,
  formatPercent,
  formatUsageSnapshot,
  imageTest: _imageTest,
};
