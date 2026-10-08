/** Better OpenAI, implemented as one Effect-managed runtime per Pi session. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import {
  loadCodePreviewSettings,
  registerCodePreviewReplay,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
} from "pi-code-previews";
import {
  bestEffortHostBootstrap,
  captureSessionHost,
  hasTerminalUI,
  invokeBestEffort,
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
import { resetOpenAICodexTransport } from "./boundary/host-codex-transport.ts";
import { containCommandFailure, safeHostSignal } from "./boundary/host-ui.ts";
import { latestOwnedCheckpoint } from "./compaction/context.ts";
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
  type FastSnapshot,
} from "./fast/controller.ts";
import { applyFastRoutingHeaders } from "./fast/routing.ts";
import { FastModeService, type FastInjectionIngress } from "./fast/service.ts";
import {
  makeOpenAIApplicationLayer,
  type OpenAIApplication,
  type OpenAIRuntimeError,
  type OpenAISessionInput,
} from "./layer.ts";
import {
  OPENAI_IMAGE_TOOL,
  registerOpenAIImage,
  registerOpenAIImageMessageRenderer,
} from "./image/register.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { fastModeFooterPrimitive, openAIUsageFooterPrimitive } from "./ui/primitives.ts";
import { OpenAIUsageService, sessionNotStarted } from "./usage/controller.ts";
import { formatDebug } from "./usage/debug.ts";
import {
  makeProjection,
  resetProjection,
  synchronizeProjectionContext,
} from "./usage/projection.ts";

const FAST_ID = "fast";
const COMMAND = "openai";

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
    name: COMMAND,
    description: "OpenAI usage, fast mode, images, and settings",
  });
  // Pi draws history before session_start, so image message and cold tool-row renderers load now.
  const noteImageCwd = registerOpenAIImageMessageRenderer(pi);
  const replay = registerCodePreviewReplay(pi, { command: COMMAND, tools: [OPENAI_IMAGE_TOOL] });
  const config = () => {
    const cfg = MutableRef.get(projection).config;
    if (cfg) return cfg;
    throw sessionNotStarted("config");
  };
  const setStatus = makeSetStatusSafely("better-openai");
  let usageVisible = true;
  const refreshForNewContext = OpenAIUsageService.use((service) =>
    service.contextChanged(true).pipe(Effect.andThen(service.refresh({ force: true }))),
  );
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
      slot.fork(refreshForNewContext);
    }
  };
  // A wanted fast mode the current model cannot use warns; every other state informs.
  const notifyFastState = (ctx: ExtensionContext, fast: FastSnapshot) =>
    notifyAtHostBoundary(
      ctx,
      fastStateText(ctx, fast),
      fast.desiredActive && !isFastActive(ctx, fast) ? "warning" : "info",
    );
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
        makeOpenAIApplicationLayer(input, {
          projection,
          fastProjection,
          isUsageVisible,
          onUsageChange: (context) => {
            if (currentContext === context) updateFooter(MutableRef.get(context));
          },
        }),
        { agentDirectory: getAgentDir, packageName: "pi-better-openai" },
      ),
    startup: ({ ctx, cwd, projectTrusted }) =>
      Effect.gen(function* () {
        yield* bestEffortHostBootstrap("pi-better-openai.preview-settings", (signal) =>
          loadPreviewSettings(cwd, projectTrusted, signal),
        );
        const fast = yield* FastModeService;
        yield* fast.initialize(ctx, config(), pi.getFlag(FAST_ID) === true);
        return {
          injectionIngress: fast.recordInjection,
          scheduler: yield* CodePreviewSchedulerService,
        };
      }),
    onActivated: (
      { ctx, context, cwd, publicationOwner },
      token,
      { injectionIngress, scheduler },
    ) => {
      currentContext = context;
      currentPublicationOwner = publicationOwner;
      recordFastInjection = injectionIngress;
      noteImageCwd({ cwd });
      const isCurrent = () => MutableRef.get(publicationOwner) && slot.isCurrent(token);
      registerOpenAIImage(pi, command, runWhen(isCurrent), updateContext, {
        noteCwd: noteImageCwd,
        scheduleAnimation: (intervalMs, tick) =>
          isCurrent() ? scheduler.schedule(intervalMs, tick) : undefined,
        isCurrent,
        shell: replay.shell,
      });
      // Only a successfully registered tool lets cold history adopt this activation's shell.
      replay.publish();
      cosmicUiWatch.start();
      updateFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive) notifyFastState(ctx, fast);
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
  const runWhen =
    (admit: () => boolean) =>
    <A, E>(effect: Effect.Effect<A, E, OpenAIApplication>, signal?: AbortSignal) =>
      admit() ? slot.run(effect, signal) : Promise.reject(sessionNotStarted());
  const run = runWhen(() => slot.isActive());

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
          Effect.sync(() => {
            if (isCurrent()) resetProviderTransport(ctx);
            if (isCurrent()) invokeBestEffort(() => updateFooter(ctx));
            if (isCurrent()) notifyFastState(ctx, MutableRef.get(fastProjection));
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

  const startSession = (ctx: ExtensionContext): Promise<void> => {
    const captured = captureSessionHost(ctx);
    if (captured._tag !== "Captured" || captured.aborted) {
      notifyAtHostBoundary(ctx, "Better OpenAI couldn't start", "warning");
      return slot.shutdown();
    }
    const { cwd, signal } = captured;
    const projectTrusted = isProjectTrusted(ctx);
    resetProviderTransport(ctx);
    const context = MutableRef.make(ctx);
    const publicationOwner = MutableRef.make(true);
    return slot
      .start({ ctx, context, cwd, projectTrusted, publicationOwner }, signal)
      .then(() => undefined);
  };
  pi.on("session_start", (_event, ctx) => {
    // Replay adoption is first-startup-only: settling without publication closes it.
    try {
      return startSession(ctx).finally(replay.finishStartup);
    } catch (error) {
      replay.finishStartup();
      throw error;
    }
  });
  pi.on("agent_start", (_event, ctx) => refreshFooter(ctx));
  pi.on("turn_end", (_event, ctx) => {
    refreshFooter(ctx);
    slot.fork(
      OpenAIUsageService.use((service) => service.refresh()),
      safeHostSignal(ctx),
    );
  });
  // The microtask turns a synchronous runner throw into the hook's own rejection path.
  const runCompaction = <A, E>(
    use: (service: OpenAICompactionService["Service"]) => Effect.Effect<A, E>,
    signal: () => AbortSignal | undefined,
  ) => Promise.resolve().then(() => run(OpenAICompactionService.use(use), signal()));
  const needsContextRepair = (ctx: ExtensionContext) =>
    invokeHostCallback(() => Boolean(latestOwnedCheckpoint(ctx.sessionManager.getBranch())), true);
  const abortIncompleteContext = (ctx: ExtensionContext) => {
    // Pi contains extension exceptions. Aborting the run is required to fail closed.
    invokeBestEffort(() => ctx.abort());
    notifyAtHostBoundary(
      ctx,
      "Couldn't restore the full conversation, so the request was cancelled",
      "warning",
    );
  };
  pi.on("session_before_compact", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) return needsContextRepair(ctx) ? { cancel: true } : undefined;
    return runCompaction(
      (service) => service.compact(event),
      () => event.signal,
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
    return runCompaction(
      (service) => service.resetRetryOmissions(),
      () => safeHostSignal(ctx),
    ).catch(() => undefined);
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
    slot.fork(refreshForNewContext, signal);
  });
  pi.on("session_shutdown", () => {
    replay.retire();
    cosmicUi.shutdown();
    return slot.shutdown();
  });
  pi.on("context_with_system", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) {
      if (needsContextRepair(ctx)) abortIncompleteContext(ctx);
      return undefined;
    }
    return runCompaction(
      (service) => service.filterContext(event.messages),
      () => safeHostSignal(ctx),
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
