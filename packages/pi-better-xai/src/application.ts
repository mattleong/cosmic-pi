/** Better xAI for pi, implemented as an Effect-managed session runtime. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import {
  captureHostSignal,
  captureSessionHost,
  hasTerminalUI,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
} from "pi-cosmic-core";
import { createCosmicFooterClient } from "pi-cosmic-ui/client";
import { notifyAtHostBoundary } from "./boundary/host-notifier.ts";
import type { ResolvedConfig } from "./config/index.ts";
import { createFooterController } from "./footer/controller.ts";
import { registerSettingsController } from "./settings/controller.ts";
import {
  makeXaiApplicationLayer,
  type XaiApplication,
  type XaiRuntimeError,
  type XaiSessionInput,
} from "./layer.ts";
import { xaiUsageFooterPrimitive, xaiUsageUiStateFromProjection } from "./ui/primitives.ts";
import {
  XaiBoundaryError,
  XaiUsageService,
  formatDebug,
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
  type XaiProjection,
} from "./usage/index.ts";

const XAI_STATUS_COMMAND = "xai-usage";

export interface BetterXaiExtensionDependencies {
  readonly startupEffect: (generation: number) => Effect.Effect<void, never, XaiUsageService>;
}

const defaultDependencies: BetterXaiExtensionDependencies = {
  startupEffect: () => XaiUsageService.use(() => Effect.void),
};

function requiredConfig(projection: MutableRef.MutableRef<XaiProjection>): ResolvedConfig {
  const config = MutableRef.get(projection).config;
  if (config) return config;
  throw new XaiBoundaryError({
    operation: "config",
    message: "Better xAI session has not started.",
  });
}

export function registerBetterXaiApplication(pi: ExtensionAPI): void {
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
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-xai");

  const config = (_ctx: ExtensionContext) => requiredConfig(projection);
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    if (!MutableRef.get(projection).config) return;
    if (!cosmicUi.active) return footerController.update(ctx);
    const usage = xaiUsageFooterPrimitive(xaiUsageUiStateFromProjection(projection));
    if (usage) cosmicUi.upsert(usage);
    else cosmicUi.remove("xai.usage");
  };

  footerController = createFooterController({ config, projection, hasTerminalUI });

  let startGeneration = 0;
  const slot = makePiSessionRuntimeSlot<XaiSessionInput, XaiApplication, never, XaiRuntimeError>({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeXaiApplicationLayer(input, {
          projection,
          onChange: (context) => updateFooter(MutableRef.get(context)),
        }),
        { agentDirectory: getAgentDir, packageName: "pi-better-xai" },
      ),
    startup: ({ generation }) => dependencies.startupEffect(generation),
    onActivated: ({ ctx }) => {
      if (hasTerminalUI(ctx)) cosmicUi.query();
      else cosmicUi.shutdown();
      updateFooter(ctx);
    },
    onDeactivated: ({ context }) => {
      if (currentContext !== context) return;
      currentContext = undefined;
      cosmicUi.shutdown();
      resetProjection(projection);
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Better xAI failed to start.", "warning");
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, XaiApplication>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  pi.registerCommand(XAI_STATUS_COMMAND, {
    description: "Show xAI subscription usage status",
    handler: (_args, ctx) => {
      const capturedSignal = captureHostSignal(ctx);
      if (capturedSignal._tag === "Unavailable") {
        notifyAtHostBoundary(ctx, "xAI usage is unavailable.", "warning");
        return Promise.resolve();
      }
      return run(
        XaiUsageService.use((service) => service.refresh({ notify: true, force: true })),
        capturedSignal.signal,
      ).catch(() => notifyAtHostBoundary(ctx, "xAI usage is unavailable.", "warning"));
    },
  });

  registerSettingsController(pi, {
    config,
    updateFooter,
    formatDebugStatus: (ctx) => formatDebug(projection, ctx),
    captureSignal: captureHostSignal,
    run,
  });

  pi.on("session_start", (_event, ctx) => {
    cosmicUi.shutdown();
    resetProjection(projection);
    const capturedHost = captureSessionHost(ctx);
    if (capturedHost._tag === "Unavailable") {
      notifyAtHostBoundary(ctx, "Better xAI failed to start.", "warning");
      return slot.shutdown().then(() => undefined);
    }
    const context = MutableRef.make(ctx);
    currentContext = context;
    if (capturedHost.aborted) {
      notifyAtHostBoundary(ctx, "Better xAI failed to start.", "warning");
    }
    return slot
      .start(
        {
          ctx,
          cwd: capturedHost.cwd,
          context,
          generation: ++startGeneration,
          projectTrusted: isProjectTrusted(ctx),
        },
        capturedHost.signal,
      )
      .then(() => undefined);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    updateFooter(ctx);
    const capturedSignal = captureHostSignal(ctx);
    if (capturedSignal._tag === "Unavailable") return;
    slot.fork(
      XaiUsageService.use((service) => service.refresh()),
      capturedSignal.signal,
    );
  });

  pi.on("model_select", (_event, ctx) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
    synchronizeProjectionContext(projection, ctx, { clearUsage: true });
    updateFooter(ctx);
    const capturedSignal = captureHostSignal(ctx);
    if (capturedSignal._tag === "Unavailable") return;
    slot.fork(
      XaiUsageService.use((service) =>
        service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
      ),
      capturedSignal.signal,
    );
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
