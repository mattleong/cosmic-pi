/** Cosmic UI host with one Effect-managed runtime per Pi session. */
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
  freezeSnapshot,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  nodePlatformLayer,
} from "pi-cosmic-core";
import {
  HostCallbackBoundary,
  makeHostCallbackBoundary,
  snapshotHostAbortSignal,
} from "./boundary/host-callback.ts";
import { CosmicUiConfigRepository } from "./config/repository.ts";
import { DEFAULT_CONFIG, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import { createFooterComponent, type FooterTotals } from "./footer/component.ts";
import {
  emptyFooterRegistrySnapshot,
  FooterRegistryService,
  type FooterRegistryBridge,
} from "./footer/registry.ts";
import { CosmicUiService, emptyTotals, makeProjection } from "./host-service.ts";
import { PiExec } from "./probe/pi-exec.ts";
import {
  FooterProtocolHost,
  makeFooterProtocolBuffer,
  protocolInvalidate,
  protocolRemove,
  protocolUpsert,
} from "./protocol-host.ts";
import { RepositoryProbe } from "./probe/repository-probe.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  normalizeCosmicFooterInvalidateEvent,
  normalizeCosmicFooterRemoveEvent,
  normalizeCosmicFooterUpsertEvent,
  normalizeCosmicUiHostQuery,
} from "./protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";

const isProjectTrusted = (ctx: ExtensionContext): boolean => {
  try {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  } catch {
    return false;
  }
};

export default function cosmicUi(pi: ExtensionAPI): void {
  const callbacks = makeHostCallbackBoundary();
  const protocolBuffer = makeFooterProtocolBuffer();
  const bridge: FooterRegistryBridge = {
    snapshot: emptyFooterRegistrySnapshot(),
    requestRenderNow: () => undefined,
    invalidate: (owner, id) => {
      protocolBuffer.offer({
        _tag: "Invalidate",
        ...(owner === undefined ? {} : { owner }),
        ...(id === undefined ? {} : { id }),
      });
    },
  };
  const projection = makeProjection();
  type SessionHostRead =
    | {
        readonly _tag: "Success";
        readonly cwd: string;
        readonly signal: AbortSignal | undefined;
        readonly aborted: boolean;
        readonly releaseSignal: () => void;
      }
    | { readonly _tag: "Failure" };
  const failedSessionHostRead: SessionHostRead = Object.freeze({ _tag: "Failure" });
  const sessionHostFrom = (ctx: ExtensionContext): SessionHostRead => {
    const cwd = callbacks.invoke<string | undefined>(
      "host-query",
      () => {
        const value = ctx.cwd;
        if (typeof value !== "string" || value.length === 0)
          throw new Error("Invalid session cwd.");
        return value;
      },
      undefined,
    );
    if (cwd === undefined) return failedSessionHostRead;
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    return abort === undefined
      ? failedSessionHostRead
      : {
          _tag: "Success",
          cwd,
          signal: abort.signal,
          aborted: abort.aborted,
          releaseSignal: abort.release,
        };
  };
  type TotalsRead =
    | { readonly _tag: "Success"; readonly totals: FooterTotals }
    | { readonly _tag: "Failure" };
  const failedTotalsRead: TotalsRead = Object.freeze({ _tag: "Failure" });
  let lastCompleteTotals = emptyTotals();
  const rememberTotals = (totals: FooterTotals) => {
    lastCompleteTotals = totals;
    return totals;
  };
  const resetTotals = () => {
    lastCompleteTotals = emptyTotals();
  };
  const totalsFromSession = (ctx: ExtensionContext): FooterTotals => {
    const read = callbacks.invoke<TotalsRead>(
      "host-query",
      () => {
        const totals = emptyTotals();
        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type !== "message" || entry.message.role !== "assistant") continue;
          const usage = entry.message.usage;
          totals.input += usage.input;
          totals.output += usage.output;
          totals.cacheRead += usage.cacheRead;
          totals.cacheWrite += usage.cacheWrite;
          totals.cost += usage.cost.total;
        }
        return { _tag: "Success", totals };
      },
      failedTotalsRead,
    );
    return read._tag === "Success" ? rememberTotals(read.totals) : lastCompleteTotals;
  };
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let installedContext: ExtensionContext | undefined;
  let footerComponent: ReturnType<typeof createFooterComponent> | undefined;
  let footerInstallGeneration = 0;
  let pendingFooterGeneration: number | undefined;
  let activeFooterGeneration: number | undefined;
  let activeFooterInstance: object | undefined;
  let activeFooterRenderRequest: (() => void) | undefined;
  let activeFooterDisposeAll: (() => void) | undefined;
  let subscriptions: Array<() => void> = [];

  const config = (): ResolvedCosmicUiConfig =>
    MutableRef.get(projection).config ?? {
      configPath: "",
      projectConfigPath: "",
      globalConfigPath: "",
      footer: { ...DEFAULT_CONFIG.footer },
    };
  const updateContext = (ctx: ExtensionContext) => {
    if (currentContext) MutableRef.set(currentContext, ctx);
  };
  const requestRender = () => bridge.requestRenderNow();
  const uninstallFooter = () => {
    const ctx = installedContext;
    if (!ctx) return;
    const generation = activeFooterGeneration;
    const disposeAll = activeFooterDisposeAll;
    const renderRequest = activeFooterRenderRequest;
    const removed = callbacks.invoke(
      "footer-remove",
      () => {
        ctx.ui.setFooter(undefined);
        return true;
      },
      false,
    );
    if (!removed) return;
    if (activeFooterGeneration !== generation) return;
    disposeAll?.();
    if (activeFooterGeneration !== generation) return;
    activeFooterGeneration = undefined;
    activeFooterInstance = undefined;
    activeFooterRenderRequest = undefined;
    activeFooterDisposeAll = undefined;
    if (installedContext === ctx) installedContext = undefined;
    footerComponent = undefined;
    pendingFooterGeneration = undefined;
    if (renderRequest)
      callbacks.invoke(
        "footer-remove",
        () =>
          slot.fork(
            FooterRegistryService.use((registry) =>
              registry.setRenderRequest(undefined, renderRequest),
            ),
          ),
        undefined,
      );
  };

  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly cwd: string;
    readonly signal: AbortSignal | undefined;
    readonly releaseSignal: () => void;
    readonly initialTotals: FooterTotals;
    readonly projectTrusted: boolean;
  };
  const makeApplicationLayer = ({ context, cwd, initialTotals, projectTrusted }: SessionInput) => {
    const callbackBoundary = HostCallbackBoundary.layer(callbacks);
    const platform = Layer.merge(
      nodePlatformLayer,
      AgentDirectory.layerFromHost(() => getAgentDir()),
    );
    const configRepository = CosmicUiConfigRepository.layer.pipe(Layer.provide(platform));
    const probe = RepositoryProbe.layer.pipe(Layer.provide(PiExec.layer));
    const service = CosmicUiService.layer({
      context,
      cwd,
      initialTotals,
      projection,
      projectTrusted,
      onChange: requestRender,
    }).pipe(Layer.provide(Layer.mergeAll(configRepository, probe, callbackBoundary)));
    const registry = FooterRegistryService.layer({
      bridge,
      publish: (snapshot) => {
        bridge.snapshot = snapshot;
      },
    }).pipe(Layer.provide(callbackBoundary));
    const protocol = FooterProtocolHost.layer({ buffer: protocolBuffer }).pipe(
      Layer.provideMerge(registry),
    );
    return Layer.merge(service, protocol);
  };
  type CosmicUiApplicationLayer = ReturnType<typeof makeApplicationLayer>;
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    Layer.Success<CosmicUiApplicationLayer>,
    never,
    Layer.Error<CosmicUiApplicationLayer>
  >({
    makeRuntime: (input) => makePiManagedRuntime(pi, makeApplicationLayer(input)),
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        yield* FooterRegistryService;
        yield* FooterProtocolHost;
      }),
    onActivated: ({ ctx, context, signal }) => {
      currentContext = context;
      update(ctx);
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        signal,
      );
    },
    onDeactivated: ({ context, releaseSignal }) => {
      releaseSignal();
      if (currentContext === context) currentContext = undefined;
      uninstallFooter();
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

  const run = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal) =>
    slot.run(effect, signal);
  const runFrom = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, ctx: ExtensionContext) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const result = run(effect, abort?.signal);
    return abort ? result.finally(abort.release) : result;
  };
  const forkFrom = <A, E>(
    effect: Effect.Effect<A, E, CosmicUiService | FooterRegistryService | FooterProtocolHost>,
    ctx: ExtensionContext,
  ) => {
    const abort = snapshotHostAbortSignal(callbacks, () => ctx.signal);
    const guarded = abort ? effect.pipe(Effect.ensuring(Effect.sync(abort.release))) : effect;
    const fiber = slot.fork(guarded, abort?.signal);
    if (!fiber) abort?.release();
    return fiber;
  };

  function update(fallback: ExtensionContext) {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const state = MutableRef.get(projection);
    const current = state.config;
    if (!current || !callbacks.invoke("host-query", () => ctx.mode === "tui", false)) return;
    if (installedContext && installedContext !== ctx) uninstallFooter();
    if (!current.footer.enabled) {
      uninstallFooter();
      return;
    }
    if (installedContext) {
      requestRender();
      return;
    }
    const generation = ++footerInstallGeneration;
    pendingFooterGeneration = generation;
    type FooterInstance = ReturnType<typeof createFooterComponent> & {
      readonly dispose: () => void;
    };
    const inertFooter = (): FooterInstance => ({
      render: () => [],
      invalidate: () => undefined,
      invalidateContextUsage: () => undefined,
      dispose: () => undefined,
    });
    let stagedComponent: ReturnType<typeof createFooterComponent> | undefined;
    let stagedInstance: object | undefined;
    let stagedRenderRequest: (() => void) | undefined;
    const attemptDisposers = new Set<() => void>();
    const ownsGeneration = () =>
      pendingFooterGeneration === generation || activeFooterGeneration === generation;
    const disposeAll = () => {
      for (const dispose of attemptDisposers) dispose();
    };
    const clearRenderRequest = (expected: () => void) =>
      callbacks.invoke(
        "footer-remove",
        () =>
          slot.fork(
            FooterRegistryService.use((registry) => registry.setRenderRequest(undefined, expected)),
          ),
        undefined,
      );
    const installed = callbacks.invoke(
      "footer-install",
      () => {
        ctx.ui.setFooter((tui, theme, footerData) => {
          if (!ownsGeneration()) return inertFooter();
          return callbacks.invoke<FooterInstance>(
            "footer-install",
            () => {
              const instance = Object.freeze({});
              const renderRequest = () => tui.requestRender();
              const component = createFooterComponent({
                pi,
                ctx: () => (currentContext ? MutableRef.get(currentContext) : ctx),
                footerData,
                theme,
                registry: {
                  snapshot: () => bridge.snapshot,
                  invalidate: () => bridge.invalidate(),
                },
                callbacks,
                config,
                totals: () => MutableRef.get(projection).totals,
                gitStatus: () => MutableRef.get(projection).gitStatus,
                pullRequestNumber: () => MutableRef.get(projection).pullRequestNumber,
                homeDirectory: () => MutableRef.get(projection).homeDirectory,
              });
              const isCurrentInstance = () =>
                activeFooterGeneration === generation
                  ? activeFooterInstance === instance
                  : pendingFooterGeneration === generation && stagedInstance === instance;
              if (activeFooterGeneration === generation) {
                activeFooterInstance = instance;
                activeFooterRenderRequest = renderRequest;
                footerComponent = component;
              } else {
                stagedInstance = instance;
                stagedRenderRequest = renderRequest;
                stagedComponent = component;
              }
              forkFrom(
                FooterRegistryService.use((registry) =>
                  Effect.suspend(() =>
                    isCurrentInstance() ? registry.setRenderRequest(renderRequest) : Effect.void,
                  ),
                ),
                currentContext ? MutableRef.get(currentContext) : ctx,
              );
              const onBranchChange = () => {
                if (!isCurrentInstance()) return;
                callbacks.invoke(
                  "request-render",
                  () => {
                    tui.requestRender();
                    forkFrom(
                      CosmicUiService.use((service) =>
                        service.invalidateProbes.pipe(Effect.andThen(service.refreshAll(true))),
                      ),
                      currentContext ? MutableRef.get(currentContext) : ctx,
                    );
                  },
                  undefined,
                );
              };
              const unsubscribeBranch = callbacks.invoke<() => void>(
                "host-query",
                () => footerData.onBranchChange(onBranchChange),
                () => undefined,
              );
              let disposed = false;
              const dispose = () => {
                if (disposed) return;
                disposed = true;
                attemptDisposers.delete(dispose);
                const currentInstance = isCurrentInstance();
                callbacks.invoke("branch-unsubscribe", unsubscribeBranch, undefined);
                if (!currentInstance) return;
                clearRenderRequest(renderRequest);
                if (activeFooterGeneration === generation) {
                  activeFooterGeneration = undefined;
                  activeFooterInstance = undefined;
                  activeFooterRenderRequest = undefined;
                  activeFooterDisposeAll = undefined;
                  installedContext = undefined;
                  if (footerComponent === component) footerComponent = undefined;
                  disposeAll();
                } else if (pendingFooterGeneration === generation) {
                  stagedInstance = undefined;
                  stagedRenderRequest = undefined;
                  if (stagedComponent === component) stagedComponent = undefined;
                  disposeAll();
                }
              };
              attemptDisposers.add(dispose);
              return { ...component, dispose };
            },
            inertFooter(),
          );
        });
        return true;
      },
      false,
    );
    if (installed && pendingFooterGeneration === generation) {
      pendingFooterGeneration = undefined;
      activeFooterGeneration = generation;
      activeFooterInstance = stagedInstance;
      activeFooterRenderRequest = stagedRenderRequest;
      activeFooterDisposeAll = disposeAll;
      installedContext = ctx;
      if (stagedComponent) footerComponent = stagedComponent;
    } else {
      if (pendingFooterGeneration === generation) pendingFooterGeneration = undefined;
      const failedRenderRequest = stagedRenderRequest;
      disposeAll();
      if (failedRenderRequest) clearRenderRequest(failedRenderRequest);
      stagedComponent = undefined;
      stagedInstance = undefined;
      stagedRenderRequest = undefined;
    }
  }

  const ensureSubscriptions = () => {
    if (subscriptions.length > 0) return;
    subscriptions = [
      pi.events.on(COSMIC_UI_HOST_QUERY, (data) => {
        const query = callbacks.invoke(
          "host-query",
          () => normalizeCosmicUiHostQuery(data),
          undefined,
        );
        if (query) callbacks.invoke("host-query", query.respond, undefined);
      }),
      pi.events.on(COSMIC_UI_FOOTER_UPSERT, (data) => {
        const event = callbacks.invoke(
          "protocol-upsert",
          () => normalizeCosmicFooterUpsertEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolUpsert(event));
      }),
      pi.events.on(COSMIC_UI_FOOTER_REMOVE, (data) => {
        const event = callbacks.invoke(
          "protocol-remove",
          () => normalizeCosmicFooterRemoveEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolRemove(event));
      }),
      pi.events.on(COSMIC_UI_FOOTER_INVALIDATE, (data) => {
        const event = callbacks.invoke(
          "protocol-invalidate",
          () => normalizeCosmicFooterInvalidateEvent(data),
          undefined,
        );
        if (event) protocolBuffer.offer(protocolInvalidate(event));
      }),
    ];
  };
  const disposeSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0))
      callbacks.invoke("event-unsubscribe", unsubscribe, undefined);
  };
  ensureSubscriptions();

  registerSettingsCommand(pi, { config, updateContext, update, run, callbacks });

  pi.on("session_start", (_event, ctx) => {
    const shutdownFailedStart = () =>
      slot.shutdown().then(() => {
        currentContext = undefined;
        resetTotals();
        MutableRef.set(
          projection,
          freezeSnapshot({
            config: undefined,
            totals: emptyTotals(),
            gitStatus: undefined,
            pullRequestNumber: undefined,
            pullRequestCheckedAt: 0,
            probeRevision: 0,
            homeDirectory: undefined,
          }),
        );
      });
    const host = sessionHostFrom(ctx);
    if (host._tag === "Failure") return shutdownFailedStart();
    if (host.aborted) {
      host.releaseSignal();
      return shutdownFailedStart();
    }
    const projectTrusted = isProjectTrusted(ctx);
    ensureSubscriptions();
    uninstallFooter();
    resetTotals();
    const initialTotals = totalsFromSession(ctx);
    MutableRef.set(
      projection,
      freezeSnapshot({
        config: undefined,
        totals: initialTotals,
        gitStatus: undefined,
        pullRequestNumber: undefined,
        pullRequestCheckedAt: 0,
        probeRevision: 0,
        homeDirectory: undefined,
      }),
    );
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
          if (token === undefined) host.releaseSignal();
        },
        () => {
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
    const read = callbacks.invoke<
      | { readonly _tag: "Assistant"; readonly totals: FooterTotals }
      | { readonly _tag: "Rescan" }
      | { readonly _tag: "Failure" }
    >(
      "host-query",
      () => {
        const message = event.message;
        if (!message || message.role !== "assistant") return { _tag: "Rescan" };
        const totals = { ...lastCompleteTotals };
        const usage = message.usage;
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheWrite += usage.cacheWrite;
        totals.cost += usage.cost.total;
        return { _tag: "Assistant", totals };
      },
      { _tag: "Failure" },
    );
    const totals =
      read._tag === "Assistant"
        ? rememberTotals(read.totals)
        : read._tag === "Rescan"
          ? totalsFromSession(ctx)
          : lastCompleteTotals;
    footerComponent?.invalidateContextUsage();
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
    footerComponent?.invalidateContextUsage();
    requestRender();
    return runFrom(
      CosmicUiService.use((service) => service.setTotals(totalsFromSession(ctx))),
      ctx,
    ).catch(() => undefined);
  };
  pi.on("session_compact", (_event, ctx) => refreshTotals(ctx));
  pi.on("session_tree", (_event, ctx) => refreshTotals(ctx));
  pi.on("model_select", (_event, ctx) => {
    updateContext(ctx);
    footerComponent?.invalidateContextUsage();
    requestRender();
  });
  pi.on("tool_execution_end", (event, ctx) => {
    updateContext(ctx);
    if (!["bash", "edit", "write"].includes(event.toolName)) return;
    return runFrom(
      CosmicUiService.use((service) => service.refreshGit(true)),
      ctx,
    ).catch(() => undefined);
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    updateContext(ctx);
    requestRender();
  });
  pi.on("session_info_changed", (_event, ctx) => {
    updateContext(ctx);
    requestRender();
  });
  const invalidateContextUsage = (_event: unknown, ctx: ExtensionContext) => {
    updateContext(ctx);
    footerComponent?.invalidateContextUsage();
    requestRender();
  };
  pi.on("agent_start", invalidateContextUsage);
  pi.on("message_start", invalidateContextUsage);
  pi.on("message_update", invalidateContextUsage);
  pi.on("message_end", invalidateContextUsage);
  pi.on("session_shutdown", () => {
    disposeSubscriptions();
    uninstallFooter();
    return slot.shutdown().then(() => {
      currentContext = undefined;
      resetTotals();
      protocolBuffer.reset();
      MutableRef.set(
        projection,
        freezeSnapshot({
          config: undefined,
          totals: emptyTotals(),
          gitStatus: undefined,
          pullRequestNumber: undefined,
          pullRequestCheckedAt: 0,
          probeRevision: 0,
          homeDirectory: undefined,
        }),
      );
    });
  });
}
