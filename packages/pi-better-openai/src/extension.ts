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
import { safeHostSignal, safeHostUi, tryHostUi } from "./boundary/host-ui.ts";
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

const hasTerminalUI = (ctx: ExtensionContext): boolean => {
  try {
    const mode = ctx.mode;
    const hasUI = ctx.hasUI;
    return mode === "tui" || (mode === undefined && hasUI);
  } catch {
    return false;
  }
};
const isProjectTrusted = (ctx: ExtensionContext): boolean => {
  try {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  } catch {
    return false;
  }
};
type SessionHostContext = {
  readonly cwd: string;
  readonly signal: AbortSignal | undefined;
  readonly aborted: boolean;
};
type SessionHostCapture =
  | { readonly _tag: "Success"; readonly value: SessionHostContext }
  | { readonly _tag: "Failure"; readonly error: OpenAIBoundaryError };
const captureSessionHostContext = (ctx: ExtensionContext): SessionHostCapture => {
  try {
    const cwd = ctx.cwd;
    const signal = ctx.signal;
    const aborted = signal?.aborted === true;
    if (typeof cwd !== "string" || cwd.length === 0)
      throw new Error("The host returned an invalid working directory.");
    return { _tag: "Success", value: { cwd, signal, aborted } };
  } catch {
    return {
      _tag: "Failure",
      error: new OpenAIBoundaryError({
        operation: "session-context",
        message: "Unable to capture the Pi session context.",
      }),
    };
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
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly aborted: boolean;
    readonly generation: number;
    readonly projectTrusted: boolean;
  };
  const makeApplicationLayer = ({ context, cwd, projectTrusted }: SessionInput) => {
    const usage = OpenAIUsageService.layer({
      context,
      cwd,
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
    return Layer.mergeAll(usage, fast, image).pipe(Layer.provide(platform));
  };
  type OpenAIApplicationLayer = ReturnType<typeof makeApplicationLayer>;
  type OpenAIApplication = Layer.Success<OpenAIApplicationLayer>;
  type OpenAIRuntimeError = Layer.Error<OpenAIApplicationLayer>;
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    OpenAIApplication,
    OpenAIConfigError,
    OpenAIRuntimeError
  >({
    makeRuntime: (input) => makePiManagedRuntime(pi, makeApplicationLayer(input)),
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
        safeHostUi(() => ctx.ui.notify(unsupportedRequestMessage(ctx), "warning"));
      if (isFastActive(ctx, fast))
        safeHostUi(() => ctx.ui.notify(fastStateText(ctx, fast), "info"));
    },
    onDeactivated: ({ context }) => {
      sessionActive = false;
      if (currentContext === context) currentContext = undefined;
      cosmicUiAdapter.shutdown();
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
        safeHostUi(() => ctx.ui.notify("Usage: /fast", "error"));
        return Promise.resolve();
      }
      const desired = !MutableRef.get(fastProjection).desiredActive;
      return run(
        FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
          Effect.tap(() =>
            Effect.gen(function* () {
              yield* tryHostUi("fast.render", () => updateFooter(ctx)).pipe(
                Effect.catchTag("OpenAIHostUiError", () => Effect.void),
              );
              const fast = MutableRef.get(fastProjection);
              const active = isFastActive(ctx, fast);
              yield* tryHostUi("fast.notify", () =>
                ctx.ui.notify(
                  fast.desiredActive && !active
                    ? unsupportedRequestMessage(ctx)
                    : fastStateText(ctx, fast),
                  fast.desiredActive && !active ? "warning" : "info",
                ),
              ).pipe(Effect.catchTag("OpenAIHostUiError", () => Effect.void));
            }),
          ),
        ),
        safeHostSignal(ctx),
      );
    },
  });
  pi.registerCommand(OPENAI_STATUS_COMMAND, {
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
    cosmicUiAdapter.shutdown();
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
          signal,
          aborted,
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
  pi.on("session_compact", (_event, ctx) => refreshFooter(ctx));
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
