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
  registerExtensionCommand,
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

export function registerBetterXaiApplication(
  pi: ExtensionAPI,
  /** Startup lifecycle test seam; Pi always uses the default. */
  startupEffect: () => Effect.Effect<void, never, XaiUsageService> = () =>
    XaiUsageService.use(() => Effect.void),
): void {
  const projection = makeProjection();
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let currentPublicationOwner: MutableRef.MutableRef<boolean> | undefined;
  const captureAuthority = () => {
    const owner = currentPublicationOwner;
    return () =>
      owner === undefined ? currentPublicationOwner === undefined : MutableRef.get(owner);
  };
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-xai");
  const warnStartFailure = (ctx: ExtensionContext) =>
    notifyAtHostBoundary(ctx, "Better xAI couldn't start", "warning");

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
    startup: startupEffect,
    onActivated: ({ ctx, context, publicationOwner }) => {
      currentContext = context;
      currentPublicationOwner = publicationOwner;
      cosmicUiWatch.start();
      updateFooter(ctx);
    },
    onDeactivated: ({ context, publicationOwner }) => {
      // Masked durable commits may finish, but no retired session may republish.
      MutableRef.set(publicationOwner, false);
      if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
      if (currentContext === context) {
        setStatus(MutableRef.get(context), undefined);
        currentContext = undefined;
      }
      cosmicUiWatch.stop();
      cosmicUi.shutdown();
      resetProjection(projection);
    },
    onStartFailure: ({ ctx }) => warnStartFailure(ctx),
  });

  const command = registerExtensionCommand(pi, {
    name: "xai",
    description: "xAI usage and settings",
  });
  command.add({
    name: "usage",
    description: "Show xAI subscription usage",
    handler: (_args, ctx) => {
      const isCurrent = captureAuthority();
      const capturedSignal = captureHostSignal(ctx);
      if (capturedSignal._tag === "Unavailable") {
        if (isCurrent()) notifyAtHostBoundary(ctx, "Couldn't check xAI usage", "warning");
        return Promise.resolve();
      }
      return slot
        .run(
          XaiUsageService.use((service) => service.refresh({ notify: true, force: true })),
          capturedSignal.signal,
        )
        .catch(() => {
          if (isCurrent() && !capturedSignal.signal?.aborted)
            notifyAtHostBoundary(ctx, "Couldn't check xAI usage", "warning");
        });
    },
  });

  registerSettingsController(command, {
    config,
    updateFooter,
    formatDebugStatus: (ctx) => formatDebug(projection, ctx),
    run: slot.run,
    captureAuthority,
  });

  pi.on("session_start", (_event, ctx) => {
    const capturedHost = captureSessionHost(ctx);
    if (capturedHost._tag === "Unavailable") {
      warnStartFailure(ctx);
      return slot.shutdown().then(() => undefined);
    }
    if (capturedHost.aborted) warnStartFailure(ctx);
    return slot
      .start(
        {
          ctx,
          cwd: capturedHost.cwd,
          context: MutableRef.make(ctx),
          projectTrusted: isProjectTrusted(ctx),
          publicationOwner: MutableRef.make(true),
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
