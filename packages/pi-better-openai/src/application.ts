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
  loadCodePreviewSettings,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  hasTerminalUI,
  invokeHostCallback,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
  failureMessage,
  registerExtensionCommand,
} from "pi-cosmic-core";
import { createCosmicFooterClient, makeHostStateWatch } from "pi-cosmic-ui/client";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import {
  applyFastRoutingHeaders,
  resetOpenAICodexTransport,
} from "./boundary/host-provider-routing.ts";
import {
  containCommandFailure,
  ignoreHostUi,
  safeHostSignal,
  safeHostUi,
} from "./boundary/host-ui.ts";
import { latestOwnedCompaction } from "./compaction/context.ts";
import { decodeOpenAICompactionDetails } from "./compaction/protocol.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import type { OpenAIConfigError } from "./config/store.ts";
import {
  fastDebugLines,
  fastStateText,
  inactiveForModelMessage,
  initialFastSnapshot,
  injectProviderPayload,
  isFastActive,
  statusSegment,
  unsupportedRequestMessage,
} from "./fast/controller.ts";
import { FastModeService, type FastInjectionIngress } from "./fast/service.ts";
import {
  makeOpenAIApplicationLayer,
  type OpenAIApplication,
  type OpenAIRuntimeError,
  type OpenAISessionInput,
} from "./layer.ts";
import { registerOpenAIImage } from "./image/register.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { fastModeFooterPrimitive, openAIUsageFooterPrimitive } from "./ui/primitives.ts";
import { OpenAIBoundaryError, OpenAIUsageService } from "./usage/controller.ts";
import { formatDebug } from "./usage/debug.ts";
import {
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
} from "./usage/projection.ts";

const FAST_ID = "fast";

export interface BetterOpenAIExtensionDependencies {
  readonly loadPreviewSettings?: (
    projectCwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly resetOpenAICodexTransport?: (ctx: ExtensionContext) => void;
}

/** Pi registration; `dependencies` is the seam for deterministic lifecycle/finalizer tests. */
export function betterOpenAIWithDependencies(
  pi: ExtensionAPI,
  dependencies: BetterOpenAIExtensionDependencies = {},
): void {
  const projection = makeProjection();
  const fastProjection = MutableRef.make(initialFastSnapshot());
  const resetProviderTransport =
    dependencies.resetOpenAICodexTransport ?? resetOpenAICodexTransport;
  const loadPreviewSettings = dependencies.loadPreviewSettings ?? loadCodePreviewSettings;
  let recordFastInjection: FastInjectionIngress = () => undefined;
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let currentPublicationOwner: MutableRef.MutableRef<boolean> | undefined;
  const captureAuthority = () => {
    const owner = currentPublicationOwner;
    return () =>
      owner === undefined ? currentPublicationOwner === undefined : MutableRef.get(owner);
  };
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-openai");
  // `/openai image` arrives with each session; the startup flag keeps its short `--fast` name.
  const command = registerExtensionCommand(pi, {
    name: "openai",
    description: "OpenAI usage, fast mode, images, and settings",
  });
  const config = () => {
    const cfg = MutableRef.get(projection).config;
    if (cfg) return cfg;
    throw new OpenAIBoundaryError({
      operation: "config",
      message: "Better OpenAI session has not started.",
    });
  };
  const setStatus = makeSetStatusSafely("better-openai");
  let usageVisible = true;
  const isUsageVisible = () => {
    cosmicUi.query();
    return cosmicUi.isVisible("openai.usage");
  };
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(projection).config;
    if (!cfg) return;
    const nextUsageVisible = isUsageVisible();
    const fast = cosmicUi.isVisible("openai.fast")
      ? fastModeFooterPrimitive(ctx, MutableRef.get(fastProjection))
      : undefined;
    const usage = nextUsageVisible ? openAIUsageFooterPrimitive(ctx, cfg, projection) : undefined;
    if (hasTerminalUI(ctx) && cosmicUi.installed) {
      if (fast) cosmicUi.upsert(fast);
      else cosmicUi.remove("openai.fast");
      if (usage) cosmicUi.upsert(usage);
      else cosmicUi.remove("openai.usage");
    }
    setStatus(
      ctx,
      hasTerminalUI(ctx) && cosmicUi.active
        ? undefined
        : [fast ? statusSegment(ctx, MutableRef.get(fastProjection)) : undefined, usage?.text]
            .filter(Boolean)
            .join(" | ") || undefined,
    );
    if (usageVisible !== nextUsageVisible) {
      usageVisible = nextUsageVisible;
      slot.fork(
        OpenAIUsageService.use((service) =>
          service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
        ),
      );
    }
  };
  const refreshFooter = (ctx: ExtensionContext) => {
    updateContext(ctx);
    updateFooter(ctx);
  };
  const cosmicUiWatch = makeHostStateWatch(cosmicUi, () => {
    if (currentContext) updateFooter(MutableRef.get(currentContext));
  });

  const slot = makePiSessionRuntimeSlot<
    OpenAISessionInput,
    OpenAIApplication,
    OpenAIConfigError,
    OpenAIRuntimeError,
    {
      readonly injectionIngress: FastInjectionIngress;
      readonly scheduler: CodePreviewSchedulerServiceContract;
    }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        Layer.merge(
          makeOpenAIApplicationLayer(input, {
            projection,
            fastProjection,
            isUsageVisible,
            onUsageChange: (context) => {
              if (currentContext === context) updateFooter(MutableRef.get(context));
            },
          }),
          CodePreviewSchedulerService.layer,
        ),
        { agentDirectory: getAgentDir, packageName: "pi-better-openai" },
      ),
    startup: ({ ctx, cwd, projectTrusted }) =>
      bestEffortHostBootstrap("pi-better-openai.preview-settings", (signal) =>
        loadPreviewSettings(cwd, projectTrusted, signal),
      ).pipe(
        Effect.andThen(
          FastModeService.use((service) =>
            service
              .initialize(ctx, config(), pi.getFlag(FAST_ID) === true)
              .pipe(Effect.as(service.recordInjection)),
          ),
        ),
        Effect.flatMap((injectionIngress) =>
          CodePreviewSchedulerService.pipe(
            Effect.map((scheduler) => ({ injectionIngress, scheduler })),
          ),
        ),
      ),
    onActivated: ({ ctx, context, publicationOwner }, token, { injectionIngress, scheduler }) => {
      currentContext = context;
      currentPublicationOwner = publicationOwner;
      recordFastInjection = injectionIngress;
      const isCurrent = () => MutableRef.get(publicationOwner) && slot.isCurrent(token);
      registerOpenAIImage(
        pi,
        command,
        (effect, signal) =>
          isCurrent()
            ? run(effect, signal)
            : Promise.reject(
                new OpenAIBoundaryError({
                  operation: "runtime",
                  message: "Better OpenAI session has not started.",
                }),
              ),
        updateContext,
        (intervalMs, tick) => (isCurrent() ? scheduler.schedule(intervalMs, tick) : undefined),
        isCurrent,
      );
      cosmicUiWatch.start();
      updateFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive && !isFastActive(ctx, fast))
        notifyAtHostBoundary(ctx, unsupportedRequestMessage(ctx), "warning");
      if (isFastActive(ctx, fast)) notifyAtHostBoundary(ctx, fastStateText(ctx, fast), "info");
    },
    onDeactivated: ({ context, publicationOwner }) => {
      // Revocation must precede reset and disposal: admitted durable commits may finish.
      MutableRef.set(publicationOwner, false);
      if (currentPublicationOwner === publicationOwner) currentPublicationOwner = undefined;
      if (currentContext === context) {
        setStatus(MutableRef.get(context), undefined);
        currentContext = undefined;
      }
      cosmicUiWatch.stop();
      recordFastInjection = () => undefined;
      cosmicUi.shutdown();
      resetProjection(projection);
      MutableRef.set(fastProjection, initialFastSnapshot());
    },
    onStartFailure: ({ ctx }) => {
      notifyAtHostBoundary(ctx, "Better OpenAI couldn't start", "warning");
    },
  });
  const run = <A, E>(effect: Effect.Effect<A, E, OpenAIApplication>, signal?: AbortSignal) =>
    slot.isActive()
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
  const COMMAND_VERBS = { "fast mode": "change fast mode", usage: "check OpenAI usage" } as const;
  const runHostCommand = <A>(
    effect: Effect.Effect<A, { readonly message: string }, OpenAIApplication>,
    operation: "fast mode" | "usage",
    ctx: ExtensionContext,
    signal: AbortSignal | undefined,
  ) => {
    const isCurrent = captureAuthority();
    return run(
      containCommandFailure(
        effect,
        ctx,
        {
          failed: (message) =>
            `Couldn't ${COMMAND_VERBS[operation]}: ${failureMessage(message, "unknown error")}`,
          unexpected: `Couldn't ${COMMAND_VERBS[operation]}`,
          defect: `Better OpenAI ${operation} raised an unexpected defect.`,
        },
        () => isCurrent() && !signal?.aborted,
      ).pipe(Effect.asVoid),
      signal,
    ).catch(() => {
      if (isCurrent() && !signal?.aborted)
        notifyAtHostBoundary(ctx, `Couldn't ${COMMAND_VERBS[operation]}`, "warning");
    });
  };

  command.add({
    name: "usage",
    description: "Show OpenAI subscription usage",
    handler: (_args, ctx) => {
      updateContext(ctx);
      const signal = safeHostSignal(ctx);
      const refresh = OpenAIUsageService.use((service) =>
        service.refresh({ notify: true, force: true }),
      );
      return runHostCommand(refresh, "usage", ctx, signal);
    },
  });
  command.add({
    name: "fast",
    description: "Toggle OpenAI fast mode",
    handler: (args, ctx) => {
      updateContext(ctx);
      if (args.trim()) {
        notifyAtHostBoundary(ctx, "Usage: /openai fast", "warning");
        return Promise.resolve();
      }
      const desired = !MutableRef.get(fastProjection).desiredActive;
      const isCurrent = captureAuthority();
      const signal = safeHostSignal(ctx);
      const update = FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
        Effect.tap(() =>
          Effect.gen(function* () {
            if (!isCurrent()) return;
            yield* Effect.sync(() => {
              if (isCurrent()) resetProviderTransport(ctx);
            });
            yield* ignoreHostUi(() => {
              if (isCurrent()) updateFooter(ctx);
            });
            const fast = MutableRef.get(fastProjection);
            const active = isFastActive(ctx, fast);
            yield* Effect.sync(() => {
              if (!isCurrent()) return;
              notifyAtHostBoundary(
                ctx,
                fast.desiredActive && !active
                  ? unsupportedRequestMessage(ctx)
                  : fastStateText(ctx, fast),
                fast.desiredActive && !active ? "warning" : "info",
              );
            });
          }),
        ),
      );
      return runHostCommand(update, "fast mode", ctx, signal);
    },
  });
  const formatDebugStatus = (ctx: ExtensionContext) => {
    const cfg = config();
    return [
      ...fastDebugLines(ctx, MutableRef.get(fastProjection)),
      `Footer usage: ${cosmicUi.isVisible("openai.usage") ? "automatic" : "hidden"} (Cosmic UI)`,
      `OpenAI compaction: ${cfg.compaction.enabled ? "enabled" : "disabled"}`,
      "",
      formatDebug(projection, ctx),
      "",
      `Image enabled: ${cfg.image.enabled}`,
      `Image default save: ${cfg.image.defaultSave}`,
      `Config: ${cfg.configPath}`,
    ].join("\n");
  };
  registerSettingsController(command, {
    config: () => MutableRef.get(projection).config,
    updateContext,
    updateFooter,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport: resetProviderTransport,
    captureAuthority,
    run,
  });

  pi.on("session_start", (_event, ctx) => {
    const captured = captureSessionHost(ctx);
    if (captured._tag !== "Captured" || captured.aborted) {
      notifyAtHostBoundary(ctx, "Better OpenAI couldn't start", "warning");
      return slot.shutdown();
    }
    const { cwd, signal } = captured;
    const projectTrusted = isProjectTrusted(ctx);
    resetProviderTransport(ctx);
    const context = MutableRef.make(ctx);
    return slot
      .start(
        {
          ctx,
          context,
          cwd,
          projectTrusted,
          publicationOwner: MutableRef.make(true),
        },
        signal,
      )
      .then(() => undefined);
  });
  pi.on("agent_start", (_event, ctx) => refreshFooter(ctx));
  pi.on("turn_end", (_event, ctx) => {
    refreshFooter(ctx);
    slot.fork(
      OpenAIUsageService.use((service) => service.refresh()),
      safeHostSignal(ctx),
    );
  });
  const needsContextRepair = (ctx: ExtensionContext) =>
    invokeHostCallback(() => Boolean(latestOwnedCompaction(ctx.sessionManager.getBranch())), true);
  const abortIncompleteContext = (ctx: ExtensionContext) => {
    // Pi contains extension exceptions. Aborting the run is required to fail closed.
    safeHostUi(() => ctx.abort());
    notifyAtHostBoundary(
      ctx,
      "Couldn't restore the full conversation, so the request was cancelled",
      "warning",
    );
  };
  pi.on("session_before_compact", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) return needsContextRepair(ctx) ? { cancel: true } : undefined;
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.compact(event)),
          event.signal,
        ),
      )
      .then((compaction) => (compaction ? { compaction } : undefined))
      .catch(() => {
        const cancel = event.signal.aborted || needsContextRepair(ctx);
        if (!event.signal.aborted)
          notifyAtHostBoundary(
            ctx,
            cancel
              ? "Compaction cancelled to keep the full conversation"
              : "OpenAI compaction failed, so Pi compacted the context instead",
            "warning",
          );
        return cancel ? { cancel: true } : undefined;
      });
  });
  pi.on("session_compact", (event, ctx) => {
    refreshFooter(ctx);
    if (event.fromExtension && decodeOpenAICompactionDetails(event.compactionEntry.details))
      notifyAtHostBoundary(ctx, "Context compacted with OpenAI", "info");
  });
  pi.on("session_tree", (_event, ctx) => {
    refreshFooter(ctx);
    if (!currentContext) return undefined;
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.resetRetryOmissions()),
          safeHostSignal(ctx),
        ),
      )
      .catch(() => undefined);
  });
  pi.on("model_select", (_event, ctx) => {
    const signal = safeHostSignal(ctx);
    resetProviderTransport(ctx);
    const before = MutableRef.get(fastProjection).active;
    updateContext(ctx);
    synchronizeProjectionContext(projection, ctx);
    updateFooter(ctx);
    const fast = MutableRef.get(fastProjection);
    const active = isFastActive(ctx, fast);
    if (active !== before)
      notifyAtHostBoundary(
        ctx,
        active ? fastStateText(ctx, fast) : inactiveForModelMessage(ctx),
        active ? "info" : "warning",
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
    return slot.shutdown();
  });
  pi.on("context_with_system", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) {
      if (needsContextRepair(ctx)) abortIncompleteContext(ctx);
      return undefined;
    }
    return Promise.resolve()
      .then(() =>
        run(
          OpenAICompactionService.use((service) => service.filterContext(event.messages)),
          safeHostSignal(ctx),
        ),
      )
      .then((messages) => (messages ? { messages } : undefined))
      .catch(() => {
        if (needsContextRepair(ctx)) abortIncompleteContext(ctx);
        return undefined;
      });
  });
  pi.on("before_provider_headers", (event, ctx) => {
    updateContext(ctx);
    applyFastRoutingHeaders(event.headers, ctx, MutableRef.get(fastProjection));
  });
  pi.on("before_provider_request", (event, ctx) => {
    updateContext(ctx);
    const fastPayload = injectProviderPayload(
      event,
      ctx,
      MutableRef.get(fastProjection),
      recordFastInjection,
    );
    if (!currentContext) return fastPayload;
    return run(
      OpenAICompactionService.use((service) => service.inject(fastPayload ?? event.payload)),
      safeHostSignal(ctx),
    )
      .then((compactedPayload) => compactedPayload ?? fastPayload)
      .catch(() => fastPayload);
  });
}
