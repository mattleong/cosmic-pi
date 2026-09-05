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
import { shutdownHostUiTickers } from "./boundary/host-status.ts";
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
  let lastCompleteTotals = emptyTotals();
  const rememberTotals = (totals: FooterTotals) => {
    lastCompleteTotals = totals;
    return totals;
  };
  const resetTotals = () => {
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const read = callbacks.invoke<FooterTotals | undefined>(
      "host-query",
      () => {
        let totals = emptyTotals();
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          const usage = decodeAssistantUsage(entry.message.usage);
          if (usage === undefined) throw new Error("Invalid assistant usage.");
          const next = addAssistantUsage(totals, usage);
          if (next === undefined) throw new Error("Assistant usage totals overflowed.");
          totals = next;
        }
        return totals;
      },
      undefined,
    );
    return read === undefined ? lastCompleteTotals : rememberTotals(read);
  };
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let subscriptions: Array<() => void> = [];

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
    WorkingTimerServiceContract
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
        }),
        { agentDirectory: getAgentDir, packageName: "pi-cosmic-ui" },
      ),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        yield* FooterRegistryService;
        return yield* WorkingTimerService;
      }),
    onActivated: ({ ctx, context, signal }, token, activeWorkingTimer) => {
      currentContext = context;
      workingOwners.activate({ token, timer: activeWorkingTimer });
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

  pi.on("turn_end", (event, ctx) => {
    updateContext(ctx);
    const read = callbacks.invoke<FooterTotals | undefined | null>(
      "host-query",
      () => {
        const message: unknown = event.message;
        if (message === undefined) return undefined;
        if (!Predicate.isObject(message)) throw new Error("Invalid turn message.");
        const role = message.role;
        if (!Predicate.isString(role)) throw new Error("Invalid turn message role.");
        if (role !== "assistant") return undefined;
        const usage = decodeAssistantUsage(message.usage);
        if (usage === undefined) throw new Error("Invalid assistant usage.");
        const totals = addAssistantUsage(lastCompleteTotals, usage);
        if (totals === undefined) throw new Error("Assistant usage totals overflowed.");
        return rememberTotals(totals);
      },
      null,
    );
    const totals =
      read === undefined ? totalsFromSession(ctx) : read === null ? lastCompleteTotals : read;
    footerInstallation.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) =>
        service.setTotals(totals).pipe(Effect.andThen(service.refreshGit())),
      ),
      ctx,
    ).catch(() => undefined);
  });
  const refreshTotals = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerInstallation.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) => service.setTotals(totalsFromSession(ctx))),
      ctx,
    ).catch(() => undefined);
  };
  pi.on("session_compact", (_event, ctx) => refreshTotals(ctx));
  pi.on("session_tree", (_event, ctx) => refreshTotals(ctx));
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
    if (!workingOwners.releasePrompt()) return;
    updateContext(ctx);
    workingOwners.resumeAfterPrompt();
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
