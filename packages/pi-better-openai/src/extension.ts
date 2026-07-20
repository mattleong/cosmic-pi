/** Better OpenAI, implemented as one Effect-managed runtime per Pi session. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { nodePlatformLayer } from "pi-cosmic-core";
import { makeOpenAIRuntime } from "./boundary/runtime.ts";
import { SafeFileAdapter } from "./boundary/safe-file.ts";
import { SharpAdapter } from "./boundary/sharp.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_IMAGE_CONFIG,
  configPaths,
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

  let generation = 0;
  const makeRuntime = (
    ctx: ExtensionContext,
    context: MutableRef.MutableRef<ExtensionContext>,
    session: number,
  ) => {
    const usage = OpenAIUsageService.layer({
      context,
      cwd: ctx.cwd,
      projection,
      onChange: () => {
        if (session === generation) updateFooter(MutableRef.get(context));
      },
    });
    const image = OpenAIImageService.layer({ context, projection }).pipe(
      Layer.provide(Layer.merge(SharpAdapter.layer, SafeFileAdapter.layer)),
    );
    return makeOpenAIRuntime(pi, Layer.merge(usage, image).pipe(Layer.provide(nodePlatformLayer)));
  };
  let runtime: ReturnType<typeof makeRuntime> | undefined;
  let removeRuntimeAbortListener: (() => void) | undefined;
  let lifecycle = Promise.resolve();
  const run = <A, E>(
    effect: Effect.Effect<A, E, OpenAIUsageService | OpenAIImageService>,
    signal?: AbortSignal,
  ): Promise<A> =>
    runtime
      ? runtime.run(effect, signal)
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
    const session = ++generation;
    cosmicUiAdapter.shutdown();
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => {
        const previous = runtime;
        removeRuntimeAbortListener?.();
        removeRuntimeAbortListener = undefined;
        runtime = undefined;
        currentContext = undefined;
        return previous?.dispose();
      })
      .then(() => {
        if (session !== generation) return;
        resetProjection(projection);
        footerController.invalidateContextUsage();
        footerController.invalidateSessionName();
        const context = MutableRef.make(ctx);
        currentContext = context;
        const next = makeRuntime(ctx, context, session);
        runtime = next;
        const abort = () => {
          if (session !== generation || runtime !== next) return;
          ++generation;
          lifecycle = lifecycle
            .catch(() => undefined)
            .then(() => {
              removeRuntimeAbortListener?.();
              removeRuntimeAbortListener = undefined;
              if (runtime === next) {
                runtime = undefined;
                currentContext = undefined;
              }
              return next.dispose();
            })
            .then(() => resetProjection(projection));
        };
        ctx.signal?.addEventListener("abort", abort, { once: true });
        removeRuntimeAbortListener = () => ctx.signal?.removeEventListener("abort", abort);
        return next
          .run(
            OpenAIUsageService.use(() => Effect.void),
            ctx.signal,
          )
          .then(() => {
            if (session !== generation) return;
            const cfg = config(ctx);
            fastController.initializeForSession(ctx, cfg, pi.getFlag(FLAG) === true);
            if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
            else cosmicUiAdapter.shutdown();
            footerController.refreshTotals(ctx);
            updateFooter(ctx);
            if (fastController.desiredActive && !fastController.active)
              ctx.ui.notify(fastController.unsupportedRequestMessage(ctx), "warning");
            if (fastController.active) ctx.ui.notify(fastController.stateText(ctx), "info");
            return next.run(
              OpenAIUsageService.use((service) =>
                service.persistFast(fastController.active, fastController.desiredActive),
              ),
              ctx.signal,
            );
          });
      })
      .catch(() => {
        if (session !== generation) return;
        const failed = runtime;
        removeRuntimeAbortListener?.();
        removeRuntimeAbortListener = undefined;
        runtime = undefined;
        currentContext = undefined;
        return (failed?.dispose() ?? Promise.resolve())
          .catch(() => undefined)
          .then(() => {
            resetProjection(projection);
            ctx.ui.notify("Better OpenAI failed to start.", "warning");
          });
      });
    return lifecycle;
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
    runtime?.fork(
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
    runtime?.fork(
      OpenAIUsageService.use((service) =>
        service.persistFast(fastController.active, fastController.desiredActive),
      ),
      ctx.signal,
    );
    runtime?.fork(
      OpenAIUsageService.use((service) => service.refresh({ force: true })),
      ctx.signal,
    );
  });
  pi.on("session_shutdown", () => {
    ++generation;
    cosmicUiAdapter.shutdown();
    footerController.invalidateContextUsage();
    footerController.invalidateSessionName();
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => {
        const current = runtime;
        removeRuntimeAbortListener?.();
        removeRuntimeAbortListener = undefined;
        runtime = undefined;
        currentContext = undefined;
        return current?.dispose();
      })
      .then(() => resetProjection(projection));
    return lifecycle;
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
