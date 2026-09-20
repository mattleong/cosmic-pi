/** Cosmic UI host with one Effect-managed runtime per Pi session. */
import * as Predicate from "effect/Predicate";

import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import { isProjectTrusted, makePiManagedRuntime, makePiSessionRuntimeSlot } from "pi-cosmic-core";
import {
  makeHostCallbackBoundary,
  snapshotHostAbortSignal,
  type HostCallbackOperation,
} from "./boundary/host-callback.ts";
import { addAssistantUsage, decodeAssistantUsage } from "./boundary/host-usage.ts";
import { shutdownHostUiTickers, startHostUiTicker } from "./boundary/host-status.ts";
import { makeDefaultResolvedCosmicUiConfig, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import type { FooterTotals } from "./footer/component.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
} from "./footer/registry.ts";
import {
  makeCosmicUiApplicationLayer,
  type CosmicUiApplication,
  type CosmicUiRuntimeError,
  type CosmicUiSessionInput,
} from "./layer.ts";
import {
  CosmicUiService,
  emptyTotals,
  makeProjection,
  resetProjection,
} from "./protocol/service.ts";
import {
  makeFooterProtocolBuffer,
  protocolInvalidate,
  protocolRemove,
  protocolUpsert,
  type FooterProtocolEvent,
} from "./protocol/host.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  COSMIC_UI_HOST_STATE,
  COSMIC_UI_PROTOCOL_VERSION,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "./protocol/protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";
import { createFooterInstallation } from "./footer/installation.ts";
import { WorkingTimerService, type WorkingTimerServiceContract } from "./working/service.ts";
import { makeWorkingRunOwnerState } from "./working/owner.ts";
import { ActivityService, type ActivityServiceContract } from "./activity/service.ts";
import { makeActivityHost } from "./boundary/host-activity.ts";

export interface CosmicUiApplicationDependencies {
  readonly shutdownHostUiTickers?: () => Promise<void>;
}

export function registerCosmicUiApplication(pi: ExtensionAPI): void {
  cosmicUiWithDependencies(pi, {});
}

/** Internal seam for host-lifecycle cleanup tests. */
export function cosmicUiWithDependencies(
  pi: ExtensionAPI,
  dependencies: CosmicUiApplicationDependencies,
): void {
  const callbacks = makeHostCallbackBoundary();
  const shutdownTickers = dependencies.shutdownHostUiTickers ?? shutdownHostUiTickers;
  const protocolBuffer = makeFooterProtocolBuffer();
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: () => {
      protocolBuffer.offer(protocolInvalidate());
    },
  };
  const projection = makeProjection();
  interface SessionHostRead {
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly aborted: boolean;
    readonly releaseSignal: () => void;
  }
  const sessionHostFrom = (ctx: ExtensionContext): SessionHostRead | undefined => {
    const cwd = callbacks.invoke<string | undefined>(
      "host-query",
      () => {
        const value = ctx.cwd;
        if (!Predicate.isString(value) || value.length === 0)
          throw new Error("Invalid session cwd.");
        return value;
      },
      undefined,
    );
    if (cwd === undefined) return undefined;
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    return abort === undefined
      ? undefined
      : {
          cwd,
          signal: abort.signal,
          aborted: abort.aborted,
          releaseSignal: abort.release,
        };
  };
  let lifecycleGeneration = 0;
  let stopUsageTicker: (() => void) | undefined;
  let lastCompleteTotals = emptyTotals();
  let usageSessionManager: ExtensionContext["sessionManager"] | undefined;
  const rememberTotals = (totals: FooterTotals) => {
    lastCompleteTotals = totals;
    return totals;
  };
  const resetTotals = () => {
    usageSessionManager = undefined;
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const generation = lifecycleGeneration;
    const read = callbacks.invoke<FooterTotals | undefined>(
      "host-query",
      () => {
        let totals = emptyTotals();
        for (const entry of ctx.sessionManager.getEntries()) {
          const rawUsage =
            entry.type === "usage" || entry.type === "compaction" || entry.type === "branch_summary"
              ? entry.usage
              : entry.type === "message" &&
                  (entry.message.role === "assistant" || entry.message.role === "toolResult")
                ? entry.message.usage
                : undefined;
          if (
            rawUsage === undefined &&
            !(
              entry.type === "usage" ||
              (entry.type === "message" && entry.message.role === "assistant")
            )
          )
            continue;
          const usage = decodeAssistantUsage(rawUsage);
          if (usage === undefined) throw new Error("Invalid assistant usage.");
          const next = addAssistantUsage(totals, usage);
          if (next === undefined) throw new Error("Assistant usage totals overflowed.");
          totals = next;
        }
        return totals;
      },
      undefined,
    );
    return read === undefined || generation !== lifecycleGeneration
      ? lastCompleteTotals
      : rememberTotals(read);
  };
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let subscriptions: Array<() => void> = [];
  const ownsUsageContext = (ctx: ExtensionContext) =>
    callbacks.invoke(
      "host-query",
      () =>
        currentContext !== undefined &&
        usageSessionManager !== undefined &&
        usageSessionManager === ctx.sessionManager,
      false,
    );

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? makeDefaultResolvedCosmicUiConfig();
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  let footerInstallation!: ReturnType<typeof createFooterInstallation>;
  let publishedHostState: string | undefined;
  const publishHostState = () => {
    if (!footerInstallation) return;
    const state = {
      version: COSMIC_UI_PROTOCOL_VERSION,
      active: footerInstallation.isActive(),
      ready: currentContext !== undefined,
      hidden: [...config().footer.hidden],
    };
    const key = JSON.stringify(state);
    if (publishedHostState === key) return;
    publishedHostState = key;
    callbacks.invoke("host-query", () => pi.events.emit(COSMIC_UI_HOST_STATE, state), undefined);
  };
  const requestRender = () => {
    bridge.requestRenderNow();
    publishHostState();
  };

  const slot = makePiSessionRuntimeSlot<
    CosmicUiSessionInput,
    CosmicUiApplication,
    never,
    CosmicUiRuntimeError,
    { readonly timer: WorkingTimerServiceContract; readonly activity: ActivityServiceContract }
  >({
    makeRuntime: (input) =>
      makePiManagedRuntime(
        pi,
        makeCosmicUiApplicationLayer(input, {
          callbacks,
          bridge,
          projection,
          protocolBuffer,
          requestRender,
          activityHost,
        }),
        { agentDirectory: getAgentDir, packageName: "pi-cosmic-ui" },
      ),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        yield* FooterRegistryService;
        return { timer: yield* WorkingTimerService, activity: yield* ActivityService };
      }),
    onActivated: ({ ctx, context, signal }, token, activeWorkingTimer) => {
      currentContext = context;
      workingOwners.activate({ token, timer: activeWorkingTimer.timer });
      callbacks.invoke(
        "host-query",
        () => activityHost.activate(ctx, activeWorkingTimer.activity),
        undefined,
      );
      footerInstallation.update(ctx);
      publishHostState();
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        signal,
      );
    },
    onDeactivated: ({ context, releaseSignal }, token) => {
      releaseSignal();
      if (currentContext === context) currentContext = undefined;
      workingOwners.deactivate(token);
      activityHost.deactivate();
      footerInstallation.uninstall();
      publishHostState();
    },
    onStartFailure: ({ ctx, releaseSignal }) => {
      releaseSignal();
      callbacks.invoke(
        "notify",
        () => ctx.ui.notify("Cosmic UI failed to start.", "warning"),
        undefined,
      );
    },
  });

  const activityHost = makeActivityHost(pi, (effect, signal) => {
    slot.fork(effect.pipe(Effect.ignore), signal);
  });
  pi.registerCommand("activity", {
    description: "Browse session activity and actions",
    handler: (_args, ctx) => runFrom(activityHost.open(ctx).pipe(Effect.ignore), ctx),
  });

  const runFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const result = slot.run(effect, abort?.signal);
    return abort ? result.finally(abort.release) : result;
  };
  const forkFrom = <A, E>(
    effect: Effect.Effect<A, E, CosmicUiService | FooterRegistryService>,
    ctx: ExtensionContext,
  ) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const guarded = abort ? effect.pipe(Effect.ensuring(Effect.sync(abort.release))) : effect;
    const fiber = slot.fork(guarded, abort?.signal);
    if (!fiber) abort?.release();
    return fiber;
  };
  const workingOwners = makeWorkingRunOwnerState({
    isCurrent: (token) => slot.isCurrent(token),
    fork: (effect) => slot.fork(effect),
  });

  footerInstallation = createFooterInstallation({
    pi,
    callbacks,
    bridge,
    projection,
    config,
    currentContext: () => (currentContext ? MutableRef.get(currentContext) : undefined),
    clearRenderRequest: (expected) => {
      callbacks.invoke(
        "footer-remove",
        () =>
          slot.fork(
            FooterRegistryService.use((registry) => registry.setRenderRequest(undefined, expected)),
          ),
        undefined,
      );
    },
    installRenderRequest: (request, isCurrent, ctx) => {
      forkFrom(
        FooterRegistryService.use((registry) =>
          Effect.suspend(() => (isCurrent() ? registry.setRenderRequest(request) : Effect.void)),
        ),
        ctx,
      );
    },
    refreshAfterBranchChange: (ctx) => {
      forkFrom(
        CosmicUiService.use((service) =>
          service.invalidateProbes.pipe(Effect.andThen(service.refreshAll(true))),
        ),
        ctx,
      );
    },
    onActiveChange: publishHostState,
  });

  const onProtocolEvent = <E>(
    event: string,
    operation: HostCallbackOperation,
    normalize: <Raw>(raw: Raw) => E | undefined,
    build: (event: E) => FooterProtocolEvent,
  ): (() => void) =>
    pi.events.on(event, (data) => {
      const parsed = callbacks.invoke(operation, () => normalize(data), undefined);
      if (parsed) protocolBuffer.offer(build(parsed));
    });

  const ensureSubscriptions = () => {
    if (subscriptions.length > 0) return;
    subscriptions = [
      pi.events.on(COSMIC_UI_HOST_QUERY, (data) => {
        const query = callbacks.invoke(
          "host-query",
          () => normalizeCosmicUiHostQuery(data),
          undefined,
        );
        if (query)
          callbacks.invoke(
            "host-query",
            () =>
              query.respond({
                active: footerInstallation.isActive(),
                ready: currentContext !== undefined,
                hidden: [...config().footer.hidden],
              }),
            undefined,
          );
      }),
      onProtocolEvent(
        COSMIC_UI_FOOTER_UPSERT,
        "protocol-upsert",
        normalizeCosmicFooterUpsertEvent,
        (event) => protocolUpsert(event.owner, event.contribution),
      ),
      onProtocolEvent(
        COSMIC_UI_FOOTER_REMOVE,
        "protocol-remove",
        normalizeCosmicFooterRemoveEvent,
        (event) => protocolRemove(event.owner, event.id),
      ),
      onProtocolEvent(
        COSMIC_UI_FOOTER_INVALIDATE,
        "protocol-invalidate",
        normalizeCosmicFooterInvalidateEvent,
        (event) => protocolInvalidate(event.owner, event.id),
      ),
    ];
  };
  const disposeSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0))
      callbacks.invoke("event-unsubscribe", unsubscribe, undefined);
  };
  ensureSubscriptions();

  registerSettingsCommand(pi, {
    config,
    updateContext,
    update: footerInstallation.update,
    run: slot.run,
    callbacks,
  });

  pi.on("session_start", (_event, ctx) => {
    const generation = ++lifecycleGeneration;
    stopUsageTicker?.();
    stopUsageTicker = undefined;
    const shutdownFailedStart = () =>
      slot.shutdown().then(() => {
        if (generation !== lifecycleGeneration) return;
        currentContext = undefined;
        resetTotals();
        resetProjection(projection);
      });
    const host = sessionHostFrom(ctx);
    if (host === undefined) return shutdownFailedStart();
    if (host.aborted) {
      host.releaseSignal();
      return shutdownFailedStart();
    }
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    footerInstallation.uninstall();
    resetTotals();
    usageSessionManager = callbacks.invoke("host-query", () => ctx.sessionManager, undefined);
    const initialTotals = totalsFromSession(ctx);
    resetProjection(projection, initialTotals);
    const context = MutableRef.make(ctx);
    currentContext = context;
    return slot
      .start(
        {
          ctx,
          context,
          cwd: host.cwd,
          signal: host.signal,
          releaseSignal: host.releaseSignal,
          initialTotals,
          projectTrusted,
        },
        host.signal,
      )
      .then(
        (token) => {
          if (token !== undefined && generation === lifecycleGeneration) {
            stopUsageTicker = startHostUiTicker(1_000, () => {
              if (generation === lifecycleGeneration && currentContext === context)
                void refreshTotals(MutableRef.get(context), true);
            });
          }
          if (token === undefined) {
            // A superseded start never activates: stop publishing this dead context
            // unless a newer start already replaced it.
            if (currentContext === context) currentContext = undefined;
            host.releaseSignal();
          }
        },
        () => {
          if (currentContext === context) currentContext = undefined;
          host.releaseSignal();
          callbacks.invoke(
            "notify",
            () => ctx.ui.notify("Cosmic UI failed to start.", "warning"),
            undefined,
          );
        },
      );
  });

  pi.on("turn_end", (_event, ctx) => {
    if (!ownsUsageContext(ctx)) return;
    updateContext(ctx);
    const totals = totalsFromSession(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) =>
        service.setTotals(totals).pipe(Effect.andThen(service.refreshGit())),
      ),
      ctx,
    ).catch(() => undefined);
  });
  const refreshTotals = (ctx: ExtensionContext, idle = false) => {
    if (!ownsUsageContext(ctx)) return;
    const previous = lastCompleteTotals;
    const totals = totalsFromSession(ctx);
    if (
      idle &&
      totals.input === previous.input &&
      totals.output === previous.output &&
      totals.cacheRead === previous.cacheRead &&
      totals.cacheWrite === previous.cacheWrite &&
      totals.cost === previous.cost
    )
      return;
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
    const generation = lifecycleGeneration;
    return runFrom(
      CosmicUiService.use((service) =>
        generation === lifecycleGeneration ? service.setTotals(totals) : Effect.void,
      ),
      ctx,
    ).catch(() => undefined);
  };
  pi.on("session_compact", (_event, ctx) => refreshTotals(ctx));
  pi.on("session_tree", (_event, ctx) => refreshTotals(ctx));
  pi.on("agent_settled", (_event, ctx) => refreshTotals(ctx));
  const invalidateContextUsage = <Event>(_event: Event, ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
  };
  pi.on("model_select", invalidateContextUsage);
  pi.on("tool_execution_start", (_event, ctx) => {
    updateContext(ctx);
    workingOwners.pauseOutputForActiveRun();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    updateContext(ctx);
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    return runFrom(
      CosmicUiService.use((service) => service.refreshGit(true)),
      ctx,
    ).catch(() => undefined);
  });
  const renderUpdatedContext = <Event>(_event: Event, ctx: ExtensionContext) => {
    updateContext(ctx);
    requestRender();
  };
  pi.on("thinking_level_select", renderUpdatedContext);
  pi.on("session_info_changed", renderUpdatedContext);
  pi.on("agent_start", (event, ctx) => {
    invalidateContextUsage(event, ctx);
    workingOwners.startAgentRun();
  });
  pi.on("agent_end", (_event, ctx) => {
    updateContext(ctx);
    workingOwners.settleAgentRun();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!workingOwners.promptIdle()) return;
    updateContext(ctx);
    workingOwners.beginPrompt();
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    const resume = workingOwners.releasePrompt();
    if (!resume) return;
    updateContext(ctx);
    resume();
  });
  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", (event, ctx) => {
    invalidateContextUsage(event, ctx);
    const update = event.assistantMessageEvent;
    if (
      !update ||
      (update.type !== "text_delta" &&
        update.type !== "thinking_delta" &&
        update.type !== "toolcall_delta")
    )
      return;
    workingOwners.noteOutputCharacters(update.delta.length);
  });
  pi.on("message_end", (event, ctx) => {
    invalidateContextUsage(event, ctx);
    workingOwners.pauseOutputForActiveRun();
  });
  pi.on("session_shutdown", () => {
    const generation = ++lifecycleGeneration;
    stopUsageTicker?.();
    stopUsageTicker = undefined;
    usageSessionManager = undefined;
    workingOwners.clearRun();
    footerInstallation.uninstall();
    disposeSubscriptions();
    return Promise.all([slot.shutdown(), shutdownTickers()]).then(() => {
      if (generation !== lifecycleGeneration) return;
      currentContext = undefined;
      resetTotals();
      protocolBuffer.reset();
      resetProjection(projection);
    });
  });
}
