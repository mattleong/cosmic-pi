import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as MutableRef from "effect/MutableRef";
import * as Predicate from "effect/Predicate";
import * as Str from "effect/String";
import {
  loadCodePreviewSettings,
  registerCodePreviewReplay,
  CodePreviewSchedulerService,
  type CodePreviewSchedulerServiceContract,
  type CodePreviewSettings,
} from "pi-code-previews";
import { bestEffortHostBootstrap } from "pi-cosmic-core/runtime/host-bootstrap";
import {
  captureSessionHost,
  hasTerminalUI,
  invokeBestEffort,
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { makePiManagedRuntime } from "pi-cosmic-core/runtime";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import { failureMessage } from "pi-cosmic-core/message-text";
import { registerExtensionCommand } from "pi-cosmic-core/host-command";
import { createCosmicFooterClient, createHostStateWatch } from "pi-cosmic-ui/client";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import {
  createCodexTransportReset,
  resetOpenAICodexTransport,
} from "./boundary/host-codex-transport.ts";
import { piRetryPolicy } from "./boundary/host-compaction.ts";
import { containCommandFailure, safeHostSignal } from "./boundary/host-ui.ts";
import { latestOwnedCheckpoint } from "./compaction/context.ts";
import {
  isEligibleOpenAICompactionModel,
  piAiVersions,
  projectionMatchesHost,
  type PiAiVersions,
} from "./compaction/projection.ts";
import { decodeOpenAICompactionDetails } from "./compaction/protocol.ts";
import { OpenAICompactionService } from "./compaction/service.ts";
import { OpenAIConfigService, type OpenAIConfigError } from "./config/store.ts";
import type { ResolvedConfig } from "./config/schema.ts";
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
  openAIApplicationLayer,
  type OpenAIApplication,
  type OpenAIRuntimeError,
  type OpenAISessionInput,
} from "./layer.ts";
import {
  OPENAI_IMAGE_TOOL,
  registerOpenAIImage,
  registerOpenAIImageMessageRenderer,
  type OpenAIImageMessageRenderer,
} from "./image/register.ts";
import { registerSettingsController } from "./settings/controller.ts";
import { fastModeFooterPrimitive, openAIUsageFooterPrimitive } from "./ui/primitives.ts";
import { OpenAIUsageService, sessionNotStarted } from "./usage/controller.ts";
import { formatDebug } from "./usage/debug.ts";
import { usageProjectionRef, resetProjection } from "./usage/projection.ts";

const FAST_ID = "fast";
const COMMAND = "openai";

const ignoreFastInjection: FastInjectionIngress = () => undefined;

const notifyFastState = (ctx: ExtensionContext, fast: FastSnapshot) =>
  notifyAtHostBoundary(
    ctx,
    fastStateText(ctx, fast),
    fast.desiredActive && !isFastActive(ctx, fast) ? "warning" : "info",
  );

const needsContextRepair = (ctx: ExtensionContext) =>
  invokeHostCallback(() => Boolean(latestOwnedCheckpoint(ctx.sessionManager.getBranch())), true);

const abortIncompleteContext = (ctx: ExtensionContext) => {
  invokeBestEffort(() => ctx.abort());
  notifyAtHostBoundary(
    ctx,
    "Couldn't restore the full conversation, so the request was cancelled",
    "warning",
  );
};

export interface BetterOpenAIExtensionDependencies {
  readonly loadPreviewSettings?: (
    projectCwd: string,
    projectTrusted: boolean,
    signal?: AbortSignal,
  ) => PromiseLike<CodePreviewSettings | void>;
  readonly resetOpenAICodexTransport?: (ctx: ExtensionContext) => void;
  readonly imageMessageRenderer?: OpenAIImageMessageRenderer;
  readonly piAiVersions?: PiAiVersions;
  readonly loadSettingsMenu?: () => PromiseLike<typeof import("./settings/menu.ts")>;
}

export function betterOpenAIWithDependencies(
  pi: ExtensionAPI,
  dependencies: BetterOpenAIExtensionDependencies = {},
): void {
  const projection = usageProjectionRef();
  const configProjection = MutableRef.make<ResolvedConfig | undefined>(undefined);
  const fastProjection = MutableRef.make(initialFastSnapshot());
  const providerTransport = createCodexTransportReset(
    dependencies.resetOpenAICodexTransport ?? resetOpenAICodexTransport,
  );
  const loadPreviewSettings = dependencies.loadPreviewSettings ?? loadCodePreviewSettings;
  const versions = dependencies.piAiVersions ?? piAiVersions;
  const projectionMismatch = projectionMatchesHost(versions)
    ? undefined
    : `Better OpenAI's pi-ai ${versions.projection} doesn't match Pi's ${versions.host}`;
  let recordFastInjection = ignoreFastInjection;
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const cosmicUi = createCosmicFooterClient(pi.events, "pi-better-openai");
  const command = registerExtensionCommand(pi, {
    name: COMMAND,
    description: "OpenAI usage, fast mode, images, and settings",
  });
  const noteImageCwd = registerOpenAIImageMessageRenderer(pi, dependencies.imageMessageRenderer);
  const replay = registerCodePreviewReplay(pi, { command: COMMAND, tools: [OPENAI_IMAGE_TOOL] });
  const config = () => {
    const cfg = MutableRef.get(configProjection);
    if (cfg) return cfg;
    throw sessionNotStarted("config");
  };
  const setStatus = makeSetStatusSafely("better-openai");
  const clearUsageForNewContext = OpenAIUsageService.use((service) => service.contextChanged(true));
  const refreshUsage = OpenAIUsageService.use((service) => service.refresh({ force: true }));
  const syncUsageVisibility = OpenAIUsageService.use((service) => service.visibilityChanged());
  const isUsageVisible = () => {
    cosmicUi.query();
    return cosmicUi.isVisible("openai.usage");
  };
  const updateFooter = (fallback: ExtensionContext) => {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const cfg = MutableRef.get(configProjection);
    if (!cfg) return;
    const fast = cosmicUi.isVisible("openai.fast")
      ? fastModeFooterPrimitive(ctx, MutableRef.get(fastProjection))
      : undefined;
    const usage = isUsageVisible() ? openAIUsageFooterPrimitive(ctx, cfg, projection) : undefined;
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
        : Arr.join(
            Arr.filter(
              [fast ? statusSegment(ctx, MutableRef.get(fastProjection)) : undefined, usage?.text],
              (part): part is string => Predicate.isString(part) && Str.isNonEmpty(part),
            ),
            " | ",
          ) || undefined,
    );
  };
  /** Renders, then lets the usage service react if the render found usage shown or hidden. */
  const renderFooter = (ctx: ExtensionContext) => {
    updateFooter(ctx);
    slot.fork(syncUsageVisibility);
  };
  const refreshFooter = (ctx: ExtensionContext) => {
    updateContext(ctx);
    renderFooter(ctx);
  };
  const cosmicUiWatch = createHostStateWatch(cosmicUi, () => {
    if (currentContext) renderFooter(MutableRef.get(currentContext));
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
        openAIApplicationLayer(input, {
          projection,
          configProjection,
          fastProjection,
          isUsageVisible,
          onUsageChange: (context) => {
            if (currentContext === context) updateFooter(MutableRef.get(context));
          },
          createCheckpoints: projectionMismatch === undefined,
          retryPolicy: () => piRetryPolicy(pi),
        }),
        { agentDirectory: getAgentDir, packageName: "pi-better-openai" },
      ),
    startup: Effect.fn("BetterOpenAI.startup")(function* ({ ctx, cwd, projectTrusted }) {
      yield* bestEffortHostBootstrap("pi-better-openai.preview-settings", (signal) =>
        loadPreviewSettings(cwd, projectTrusted, signal),
      );
      const fast = yield* FastModeService;
      const configService = yield* OpenAIConfigService;
      yield* fast.initialize(ctx, yield* configService.get, pi.getFlag(FAST_ID) === true);
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
      replay.publish();
      cosmicUiWatch.start();
      renderFooter(ctx);
      const fast = MutableRef.get(fastProjection);
      if (fast.desiredActive) notifyFastState(ctx, fast);
    },
    onDeactivated: ({ context, publicationOwner }) => {
      MutableRef.set(publicationOwner, false);
      if (currentContext === context) {
        setStatus(MutableRef.get(context), undefined);
        currentContext = undefined;
      }
      cosmicUiWatch.stop();
      recordFastInjection = ignoreFastInjection;
      cosmicUi.shutdown();
      resetProjection(projection);
      MutableRef.set(configProjection, undefined);
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
    const isCurrent = slot.captureAuthority();
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
      if (Str.trim(args)) {
        notifyAtHostBoundary(ctx, "Usage: /openai fast", "warning");
        return Promise.resolve();
      }
      const desired = !MutableRef.get(fastProjection).desiredActive;
      const isCurrent = slot.captureAuthority();
      const signal = safeHostSignal(ctx);
      const update = FastModeService.use((service) => service.setDesired(ctx, desired)).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (isCurrent()) providerTransport.request(ctx);
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
    return Arr.join(
      [
        ...fastDebugLines(ctx, MutableRef.get(fastProjection)),
        `Footer usage: ${cosmicUi.isVisible("openai.usage") ? "automatic" : "hidden"} (Cosmic UI)`,
        `OpenAI compaction: ${cfg.compaction.enabled ? "enabled" : "disabled"}${projectionMismatch ? ` (unavailable: ${projectionMismatch})` : ""}`,
        "",
        formatDebug(projection, ctx),
        "",
        `Image enabled: ${cfg.image.enabled}`,
        `Image default save: ${cfg.image.defaultSave}`,
        `Config: ${cfg.configPath}`,
      ],
      "\n",
    );
  };
  registerSettingsController(command, {
    config: () => MutableRef.get(configProjection),
    updateContext,
    updateFooter,
    formatDebugStatus,
    fastProjection,
    resetFastRoutingTransport: providerTransport.request,
    captureAuthority: slot.captureAuthority,
    ...(dependencies.loadSettingsMenu && { loadMenu: dependencies.loadSettingsMenu }),
    run,
  });

  const startSession = (ctx: ExtensionContext): Promise<void> => {
    const captured = captureSessionHost(ctx);
    if (!Predicate.isTagged(captured, "Captured") || captured.aborted) {
      notifyAtHostBoundary(ctx, "Better OpenAI couldn't start", "warning");
      return slot.shutdown();
    }
    const { cwd, signal } = captured;
    const projectTrusted = isProjectTrusted(ctx);
    providerTransport.request(ctx);
    const context = MutableRef.make(ctx);
    const publicationOwner = MutableRef.make(true);
    return slot
      .start({ ctx, context, cwd, projectTrusted, publicationOwner }, signal)
      .then(() => undefined);
  };
  pi.on("session_start", (_event, ctx) => {
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
  const openAICompactionRequested = (ctx: ExtensionContext) =>
    MutableRef.get(configProjection)?.compaction.enabled === true &&
    invokeHostCallback(() => isEligibleOpenAICompactionModel(ctx.model), false);
  const runCompaction = <A, E>(
    use: (service: OpenAICompactionService["Service"]) => Effect.Effect<A, E>,
    signal: AbortSignal | undefined,
    isCurrent: () => boolean,
  ) => Promise.resolve().then(() => runWhen(isCurrent)(OpenAICompactionService.use(use), signal));
  pi.on("session_before_compact", (event, ctx) => {
    updateContext(ctx);
    if (!currentContext) return needsContextRepair(ctx) ? { cancel: true } : undefined;
    const signal = event.signal;
    const sessionCurrent = slot.captureAuthority();
    const isCurrent = () => sessionCurrent() && !signal.aborted;
    return runCompaction((service) => service.compact(event), signal, isCurrent)
      .then((compaction) => {
        if (!isCurrent()) return { cancel: true };
        if (projectionMismatch && openAICompactionRequested(ctx))
          notifyAtHostBoundary(
            ctx,
            `OpenAI compaction is unavailable because ${projectionMismatch}, so Pi compacted the context instead`,
            "warning",
          );
        return compaction ? { compaction } : undefined;
      })
      .catch(() => {
        if (!isCurrent()) return { cancel: true };
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
      safeHostSignal(ctx),
      slot.captureAuthority(),
    ).catch(() => undefined);
  });
  pi.on("model_select", (_event, ctx) => {
    const signal = safeHostSignal(ctx);
    providerTransport.request(ctx);
    const before = MutableRef.get(fastProjection).active;
    updateContext(ctx);
    // The usage controller clears the old model's usage and re-renders the footer. Its fiber
    // starts synchronously, so the clear usually lands before the render below. The clear isn't
    // tied to the host signal: an abort while it waits for the commit lock would leave the old
    // model's usage visible. Only the network refresh that follows it is.
    const cleared = slot.fork(clearUsageForNewContext);
    if (cleared) slot.fork(Fiber.join(cleared).pipe(Effect.andThen(refreshUsage)), signal);
    renderFooter(ctx);
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
  });
  pi.on("session_shutdown", () => {
    providerTransport.discard();
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
    const signal = safeHostSignal(ctx);
    const sessionCurrent = slot.captureAuthority();
    const isCurrent = () => sessionCurrent() && !signal?.aborted;
    return runCompaction((service) => service.filterContext(event.messages), signal, isCurrent)
      .then((messages) => (isCurrent() && messages ? { messages } : undefined))
      .catch(() => {
        if (isCurrent() && needsContextRepair(ctx)) abortIncompleteContext(ctx);
        return undefined;
      });
  });
  pi.on("before_provider_headers", (event, ctx) => {
    updateContext(ctx);
    providerTransport.beforeProviderRequest(ctx);
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
    const signal = safeHostSignal(ctx);
    const sessionCurrent = slot.captureAuthority();
    const isCurrent = () => sessionCurrent() && !signal?.aborted;
    return runWhen(isCurrent)(
      OpenAICompactionService.use((service) => service.inject(fastPayload ?? event.payload)),
      signal,
    )
      .then((compactedPayload) => (isCurrent() ? (compactedPayload ?? fastPayload) : undefined))
      .catch(() => (isCurrent() ? fastPayload : undefined));
  });
}
