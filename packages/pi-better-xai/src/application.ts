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
  notifyAtHostBoundary,
} from "pi-cosmic-core";
import { createCosmicFooterClient, makeHostStateWatch } from "pi-cosmic-ui/client";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import { registerSettingsController } from "./settings/controller.ts";
import {
  makeXaiApplicationLayer,
  type XaiApplication,
  type XaiRuntimeError,
  type XaiSessionInput,
} from "./layer.ts";
import { xaiUsageFooterPrimitive } from "./ui/primitives.ts";
import { XaiUsageService } from "./usage/controller.ts";
import { formatDebug } from "./usage/debug.ts";
import {
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
} from "./usage/projection.ts";

const XAI_STATUS_COMMAND = "xai-usage";

export interface BetterXaiExtensionDependencies {
  readonly startupEffect: () => Effect.Effect<void, never, XaiUsageService>;
}

const defaultDependencies: BetterXaiExtensionDependencies = {
  startupEffect: () => XaiUsageService.use(() => Effect.void),
};

export function registerBetterXaiApplication(
  pi: ExtensionAPI,
  dependencies: BetterXaiExtensionDependencies = defaultDependencies,
): void {
  const projection = makeProjection();
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-xai");

  const config = () => MutableRef.get(projection).config;
  const setStatus = makeSetStatusSafely("better-xai");
  let usageVisible = true;
  const isUsageVisible = () => {
    cosmicUi.query();
    return cosmicUi.isVisible("xai.usage");
  };
  const resynchronizeUsage = XaiUsageService.use((service) =>
    service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
  );
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    if (!config()) return;
    const nextUsageVisible = isUsageVisible();
    const usage = nextUsageVisible
      ? xaiUsageFooterPrimitive(MutableRef.get(projection))
      : undefined;
    if (hasTerminalUI(ctx) && cosmicUi.installed) {
      if (usage) cosmicUi.upsert(usage);
      else cosmicUi.remove("xai.usage");
    }
    setStatus(ctx, hasTerminalUI(ctx) && cosmicUi.active ? undefined : usage?.text);
    if (usageVisible !== nextUsageVisible) {
      usageVisible = nextUsageVisible;
      slot.fork(resynchronizeUsage);
    }
  };
  const cosmicUiWatch = makeHostStateWatch(cosmicUi, () => {
    if (currentContext) updateFooter(MutableRef.get(currentContext));
  });

  const slot = makePiSessionRuntimeSlot<XaiSessionInput, XaiApplication, never, XaiRuntimeError>({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeXaiApplicationLayer(input, {
          projection,
          isUsageVisible,
          onChange: () => {
            if (currentContext === input.context) updateFooter(MutableRef.get(input.context));
          },
        }),
        { agentDirectory: getAgentDir, packageName: "pi-better-xai" },
      ),
    startup: () => dependencies.startupEffect(),
    onActivated: ({ ctx, context }) => {
      currentContext = context;
      cosmicUiWatch.start();
      updateFooter(ctx);
    },
    onDeactivated: ({ context }) => {
      if (currentContext === context) {
        setStatus(MutableRef.get(context), undefined);
        currentContext = undefined;
      }
      cosmicUiWatch.stop();
      cosmicUi.shutdown();
      resetProjection(projection);
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Better xAI couldn't start", "warning");
    },
  });

  pi.registerCommand(XAI_STATUS_COMMAND, {
    description: "Show xAI subscription usage status",
    handler: (_args, ctx) => {
      const capturedSignal = captureHostSignal(ctx);
      if (capturedSignal._tag === "Unavailable") {
        notifyAtHostBoundary(ctx, "Couldn't check xAI usage", "warning");
        return Promise.resolve();
      }
      return slot
        .run(
          XaiUsageService.use((service) => service.refresh({ notify: true, force: true })),
          capturedSignal.signal,
        )
        .catch(() => notifyAtHostBoundary(ctx, "Couldn't check xAI usage", "warning"));
    },
  });

  registerSettingsController(pi, {
    config,
    updateFooter,
    formatDebugStatus: (ctx) => formatDebug(projection, ctx),
    run: slot.run,
  });

  pi.on("session_start", (_event, ctx) => {
    cosmicUi.shutdown();
    resetProjection(projection);
    const capturedHost = captureSessionHost(ctx);
    if (capturedHost._tag === "Unavailable") {
      notifyAtHostBoundary(ctx, "Better xAI couldn't start", "warning");
      return slot.shutdown().then(() => undefined);
    }
    const context = MutableRef.make(ctx);
    if (capturedHost.aborted) {
      notifyAtHostBoundary(ctx, "Better xAI couldn't start", "warning");
    }
    return slot
      .start(
        {
          ctx,
          cwd: capturedHost.cwd,
          context,
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
    synchronizeProjectionContext(projection, ctx);
    updateFooter(ctx);
    const capturedSignal = captureHostSignal(ctx);
    if (capturedSignal._tag === "Unavailable") return;
    slot.fork(resynchronizeUsage, capturedSignal.signal);
  });

  pi.on("session_shutdown", () => slot.shutdown());
}
