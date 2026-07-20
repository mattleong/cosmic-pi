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
import { FastController, supportsFast } from "./fast-controller.ts";
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
  const fastController = new FastController(SERVICE_TIER);
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
    fastController,
    projection,
    hasTerminalUI,
  });
  cosmicUiAdapter = createCosmicUiAdapter({ pi, fastController, projection });

  let startGeneration = 0;
  let sessionActive = false;
  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly generation: number;
  };
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    OpenAIUsageService | OpenAIImageService,
    OpenAIConfigError
  >({
    makeRuntime: ({ ctx, context }) => {
      const usage = OpenAIUsageService.layer({
        context,
        cwd: ctx.cwd,
        projection,
        onChange: () => {
          if (sessionActive) updateFooter(MutableRef.get(context));
        },
      });
      const image = OpenAIImageService.layer({ context, projection }).pipe(
        Layer.provide(Layer.merge(SharpAdapter.layer, SafeFile.layer)),
      );
      const platform = Layer.merge(
        nodePlatformLayer,
        AgentDirectory.layerFromHost(() => getAgentDir()),
      );
      return makePiManagedRuntime(pi, Layer.merge(usage, image).pipe(Layer.provide(platform)));
    },
    startup: ({ ctx, generation }) =>
      dependencies.startupEffect(generation).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const cfg = config(ctx);
            fastController.initializeForSession(ctx, cfg, pi.getFlag(FLAG) === true);
          }),
        ),
        Effect.andThen(
          OpenAIUsageService.use((service) =>
            service.persistFast(fastController.active, fastController.desiredActive),
          ),
        ),
      ),
    onActivated: ({ ctx }) => {
      sessionActive = true;
      if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
      else cosmicUiAdapter.shutdown();
      footerController.refreshTotals(ctx);
      updateFooter(ctx);
      if (fastController.desiredActive && !fastController.active)
        ctx.ui.notify(fastController.unsupportedRequestMessage(ctx), "warning");
      if (fastController.active) ctx.ui.notify(fastController.stateText(ctx), "info");
    },
    onDeactivated: () => {
      sessionActive = false;
      currentContext = undefined;
      cosmicUiAdapter.shutdown();
      resetProjection(projection);
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
    effect: Effect.Effect<A, E, OpenAIUsageService | OpenAIImageService>,
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
      fastController.setDesired(ctx, !fastController.desiredActive);
      updateFooter(ctx);
      const message =
        fastController.desiredActive && !fastController.active
          ? fastController.unsupportedRequestMessage(ctx)
          : fastController.stateText(ctx);
      ctx.ui.notify(
        message,
        fastController.desiredActive && !fastController.active ? "warning" : "info",
      );
      return run(
        OpenAIUsageService.use((service) =>
          service.persistFast(fastController.active, fastController.desiredActive),
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
      ...fastController.debugLines(ctx),
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
    fastController,
    run,
  });
  registerOpenAIImage(pi, run, updateContext);

  pi.on("session_start", (_event, ctx) => {
    cosmicUiAdapter.shutdown();
    resetProjection(projection);
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
      .start({ ctx, context, generation: ++startGeneration }, ctx.signal)
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
    updateContext(ctx);
    footerController.invalidateContextUsage();
    const wasActive = fastController.active;
    fastController.applyDesiredState(ctx);
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    if (fastController.active !== wasActive)
      ctx.ui.notify(
        fastController.active
          ? fastController.stateText(ctx)
          : fastController.inactiveForModelMessage(ctx),
        fastController.active ? "info" : "warning",
      );
    slot.fork(
      OpenAIUsageService.use((service) =>
        service.persistFast(fastController.active, fastController.desiredActive),
      ),
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
    return fastController.injectProviderPayload(event, ctx);
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
