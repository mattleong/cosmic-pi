/** Better xAI for pi, implemented as an Effect-managed session runtime. */
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
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  nodePlatformLayer,
} from "pi-cosmic-core";
import type { ResolvedConfig } from "./config.ts";
import { createFooterController } from "./footer/controller.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { createCosmicUiAdapter } from "./ui/cosmic-adapter.ts";
import {
  XaiBoundaryError,
  XaiUsageService,
  formatDebug,
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
  type XaiProjection,
} from "./usage-controller.ts";

const XAI_STATUS_COMMAND = "xai-usage";

export interface BetterXaiExtensionDependencies {
  readonly startupEffect: (generation: number) => Effect.Effect<void, never, XaiUsageService>;
}

const defaultDependencies: BetterXaiExtensionDependencies = {
  startupEffect: () => XaiUsageService.use(() => Effect.void),
};

function hasTerminalUI(ctx: ExtensionContext): boolean {
  return ctx.mode === "tui" || (ctx.mode === undefined && ctx.hasUI);
}

function requiredConfig(projection: MutableRef.MutableRef<XaiProjection>): ResolvedConfig {
  const config = MutableRef.get(projection).config;
  if (config) return config;
  throw new XaiBoundaryError({
    operation: "config",
    message: "Better xAI session has not started.",
  });
}

export default function betterXai(pi: ExtensionAPI): void {
  betterXaiWithDependencies(pi, defaultDependencies);
}

/** Internal seam for deterministic lifecycle/finalizer tests. */
export function betterXaiWithDependencies(
  pi: ExtensionAPI,
  dependencies: BetterXaiExtensionDependencies,
): void {
  const projection = makeProjection();
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let footerController: ReturnType<typeof createFooterController>;
  const cosmicUiAdapter = createCosmicUiAdapter({ pi, projection });

  const config = (_ctx: ExtensionContext) => requiredConfig(projection);
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(projection).config;
    if (!cfg) return;
    if (cosmicUiAdapter.active) cosmicUiAdapter.update(ctx, cfg);
    else footerController.update(ctx);
  };

  footerController = createFooterController({ config, projection, hasTerminalUI });

  let startGeneration = 0;
  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly generation: number;
  };
  const slot = makePiSessionRuntimeSlot<SessionInput, XaiUsageService>({
    makeRuntime: ({ ctx, context }) => {
      const platform = Layer.merge(
        nodePlatformLayer,
        AgentDirectory.layerFromHost(() => getAgentDir()),
      );
      const applicationLayer = XaiUsageService.layer({
        context,
        cwd: ctx.cwd,
        projection,
        onChange: () => updateFooter(MutableRef.get(context)),
      }).pipe(Layer.provide(platform));
      return makePiManagedRuntime(pi, applicationLayer);
    },
    startup: ({ generation }) => dependencies.startupEffect(generation),
    onActivated: ({ ctx }) => {
      if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
      else cosmicUiAdapter.shutdown();
      updateFooter(ctx);
    },
    onDeactivated: () => {
      currentContext = undefined;
      cosmicUiAdapter.shutdown();
      resetProjection(projection);
    },
    onStartFailure: ({ ctx }) => {
      try {
        ctx.ui.notify("Better xAI failed to start.", "warning");
      } catch {
        // Host notification failures do not prevent runtime cleanup.
      }
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, XaiUsageService>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  pi.registerCommand(XAI_STATUS_COMMAND, {
    description: "Show xAI subscription usage status",
    handler: (_args, ctx) =>
      run(
        XaiUsageService.use((service) => service.refresh({ notify: true, force: true })),
        ctx.signal,
      ).catch(() => ctx.ui.notify("xAI usage is unavailable.", "warning")),
  });

  registerSettingsController(pi, {
    config,
    updateFooter,
    formatDebugStatus: (ctx) => formatDebug(projection, ctx),
    run,
  });

  pi.on("session_start", (_event, ctx) => {
    cosmicUiAdapter.shutdown();
    resetProjection(projection);
    const context = MutableRef.make(ctx);
    currentContext = context;
    if (ctx.signal?.aborted) {
      try {
        ctx.ui.notify("Better xAI failed to start.", "warning");
      } catch {
        // Host notification failures do not prevent runtime cleanup.
      }
    }
    return slot
      .start({ ctx, context, generation: ++startGeneration }, ctx.signal)
      .then(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    updateFooter(ctx);
    slot.fork(
      XaiUsageService.use((service) => service.refresh()),
      ctx.signal,
    );
  });

  pi.on("model_select", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    slot.fork(
      XaiUsageService.use((service) =>
        service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
      ),
      ctx.signal,
    );
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
