/** Better xAI for pi, implemented as an Effect-managed session runtime. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as MutableRef from "effect/MutableRef";
import { nodePlatformLayer } from "pi-cosmic-core";
import { makeXaiRuntime } from "./boundary/runtime.ts";
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

  let sessionGeneration = 0;
  const makeRuntime = (
    ctx: ExtensionContext,
    context: MutableRef.MutableRef<ExtensionContext>,
    generation: number,
  ) => {
    const applicationLayer = XaiUsageService.layer({
      context,
      cwd: ctx.cwd,
      projection,
      onChange: () => {
        if (generation === sessionGeneration) updateFooter(MutableRef.get(context));
      },
    }).pipe(Layer.provide(nodePlatformLayer));
    return makeXaiRuntime(pi, applicationLayer);
  };
  type XaiRuntime = ReturnType<typeof makeRuntime>;
  let runtime: XaiRuntime | undefined;
  let lifecycle = Promise.resolve();
  let removeAbortListener: (() => void) | undefined;
  const clearAbortListener = () => {
    const remove = removeAbortListener;
    removeAbortListener = undefined;
    try {
      remove?.();
    } catch {
      // A malformed session signal cannot block runtime disposal.
    }
  };
  const disposals = new WeakMap<XaiRuntime, Promise<void>>();
  const disposeNow = (target: XaiRuntime | undefined): Promise<void> => {
    if (!target) return Promise.resolve();
    const existing = disposals.get(target);
    if (existing) return existing;
    const disposal = target.dispose().catch(() => undefined);
    disposals.set(target, disposal);
    return disposal;
  };

  const run = <A, E>(
    effect: Effect.Effect<A, E, XaiUsageService>,
    signal?: AbortSignal,
  ): Promise<A> => {
    if (runtime) return runtime.run(effect, signal);
    return Promise.reject(
      new XaiBoundaryError({
        operation: "runtime",
        message: "Better xAI session has not started.",
      }),
    );
  };

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
    const generation = ++sessionGeneration;
    const previous = runtime;
    runtime = undefined;
    currentContext = undefined;
    clearAbortListener();
    const previousDisposal = disposeNow(previous);
    cosmicUiAdapter.shutdown();

    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => previousDisposal)
      .then(() => {
        if (generation !== sessionGeneration) return;
        resetProjection(projection);
        const context = MutableRef.make(ctx);
        currentContext = context;
        const next = makeRuntime(ctx, context, generation);
        runtime = next;
        const abort = () => {
          if (generation !== sessionGeneration || runtime !== next) return;
          const abortedGeneration = ++sessionGeneration;
          runtime = undefined;
          currentContext = undefined;
          clearAbortListener();
          const disposal = disposeNow(next);
          cosmicUiAdapter.shutdown();
          lifecycle = lifecycle
            .catch(() => undefined)
            .then(() => disposal)
            .then(() => {
              if (abortedGeneration === sessionGeneration && !runtime) resetProjection(projection);
            });
          return disposal;
        };
        ctx.signal?.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => ctx.signal?.removeEventListener("abort", abort);
        if (ctx.signal?.aborted) {
          runtime = undefined;
          currentContext = undefined;
          clearAbortListener();
          const disposal = disposeNow(next);
          cosmicUiAdapter.shutdown();
          try {
            ctx.ui.notify("Better xAI failed to start.", "warning");
          } catch {
            // Host notification failures do not prevent runtime cleanup.
          }
          return disposal.then(() => {
            if (generation === sessionGeneration && !runtime) resetProjection(projection);
          });
        }
        return next.run(dependencies.startupEffect(generation), ctx.signal).then(() => {
          if (generation !== sessionGeneration || runtime !== next) return;
          if (hasTerminalUI(ctx)) cosmicUiAdapter.detectHost();
          else cosmicUiAdapter.shutdown();
          updateFooter(ctx);
        });
      })
      .catch(() => {
        if (generation !== sessionGeneration) return;
        const failed = runtime;
        runtime = undefined;
        currentContext = undefined;
        clearAbortListener();
        const disposal = disposeNow(failed);
        cosmicUiAdapter.shutdown();
        try {
          ctx.ui.notify("Better xAI failed to start.", "warning");
        } catch {
          // Host notification failures do not prevent runtime cleanup.
        }
        return disposal.then(() => {
          if (generation === sessionGeneration && !runtime) resetProjection(projection);
        });
      });
    return lifecycle;
  });

  pi.on("turn_end", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    updateFooter(ctx);
    runtime?.fork(
      XaiUsageService.use((service) => service.refresh()),
      ctx.signal,
    );
  });

  pi.on("model_select", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    runtime?.fork(
      XaiUsageService.use((service) => service.refresh({ force: true })),
      ctx.signal,
    );
  });

  pi.on("session_shutdown", () => {
    const shutdownGeneration = ++sessionGeneration;
    const current = runtime;
    runtime = undefined;
    currentContext = undefined;
    clearAbortListener();
    const disposal = disposeNow(current);
    cosmicUiAdapter.shutdown();
    lifecycle = lifecycle
      .catch(() => undefined)
      .then(() => disposal)
      .then(() => {
        if (shutdownGeneration === sessionGeneration && !runtime) resetProjection(projection);
      });
    return lifecycle;
  });
}
