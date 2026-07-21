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
import { HostCallbackBoundary, makeHostCallbackBoundary } from "./boundary/host-callback.ts";
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

const terminalUi = (ctx: ExtensionContext) => ctx.mode === "tui";
const isProjectTrusted = (ctx: ExtensionContext): boolean => {
  try {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  } catch {
    return false;
  }
};

function totalsFrom(ctx: ExtensionContext): FooterTotals {
  const totals = emptyTotals();
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    totals.input += entry.message.usage.input;
    totals.output += entry.message.usage.output;
    totals.cacheRead += entry.message.usage.cacheRead;
    totals.cacheWrite += entry.message.usage.cacheWrite;
    totals.cost += entry.message.usage.cost.total;
  }
  return totals;
}

type CosmicUiRuntime = CosmicUiService | FooterRegistryService | FooterProtocolHost;

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
  let currentContext: MutableRef.MutableRef<ExtensionContext> | undefined;
  let installedContext: ExtensionContext | undefined;
  let footerComponent: ReturnType<typeof createFooterComponent> | undefined;
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
    installedContext = undefined;
    footerComponent = undefined;
    if (!ctx) return;
    callbacks.invoke("footer-remove", () => ctx.ui.setFooter(undefined), undefined);
  };

  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
    readonly projectTrusted: boolean;
  };
  const slot = makePiSessionRuntimeSlot<SessionInput, CosmicUiRuntime>({
    makeRuntime: ({ ctx, context, projectTrusted }) => {
      const platform = Layer.merge(
        nodePlatformLayer,
        AgentDirectory.layerFromHost(() => getAgentDir()),
      );
      const configRepository = CosmicUiConfigRepository.layer.pipe(Layer.provide(platform));
      const probe = RepositoryProbe.layer.pipe(Layer.provide(PiExec.layer));
      const service = CosmicUiService.layer({
        context,
        cwd: ctx.cwd,
        projection,
        projectTrusted,
        onChange: requestRender,
      }).pipe(Layer.provide(Layer.merge(configRepository, probe)));
      const registry = FooterRegistryService.layer({
        bridge,
        publish: (snapshot) => {
          bridge.snapshot = snapshot;
        },
      }).pipe(Layer.provide(HostCallbackBoundary.layer(callbacks)));
      const protocol = FooterProtocolHost.layer({ buffer: protocolBuffer }).pipe(
        Layer.provideMerge(registry),
      );
      return makePiManagedRuntime(pi, Layer.merge(service, protocol));
    },
    startup: () =>
      Effect.gen(function* () {
        yield* CosmicUiService;
        yield* FooterRegistryService;
        yield* FooterProtocolHost;
      }),
    onActivated: ({ ctx }) => {
      update(ctx);
      slot.fork(
        CosmicUiService.use((service) => service.refreshAll(true)),
        ctx.signal,
      );
    },
    onDeactivated: () => {
      currentContext = undefined;
      uninstallFooter();
    },
    onStartFailure: ({ ctx }) => {
      callbacks.invoke(
        "notify",
        () => ctx.ui.notify("Cosmic UI failed to start.", "warning"),
        undefined,
      );
    },
  });

  const run = <A, E>(effect: Effect.Effect<A, E, CosmicUiService>, signal?: AbortSignal) =>
    slot.run(effect, signal);

  function update(fallback: ExtensionContext) {
    const ctx = currentContext ? MutableRef.get(currentContext) : fallback;
    const state = MutableRef.get(projection);
    const current = state.config;
    if (!current || !terminalUi(ctx)) return;
    if (installedContext && installedContext !== ctx) uninstallFooter();
    if (!current.footer.enabled) {
      uninstallFooter();
      return;
    }
    if (installedContext) {
      requestRender();
      return;
    }
    installedContext = ctx;
    callbacks.invoke(
      "footer-install",
      () =>
        ctx.ui.setFooter((tui, theme, footerData) => {
          slot.fork(
            FooterRegistryService.use((registry) =>
              registry.setRenderRequest(() => tui.requestRender()),
            ),
            (currentContext ? MutableRef.get(currentContext) : ctx).signal,
          );
          const unsubscribeBranch = footerData.onBranchChange(() => {
            callbacks.invoke("request-render", () => tui.requestRender(), undefined);
            slot.fork(
              CosmicUiService.use((service) =>
                service.invalidateProbes.pipe(Effect.andThen(service.refreshAll(true))),
              ),
              (currentContext ? MutableRef.get(currentContext) : ctx).signal,
            );
          });
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
          footerComponent = component;
          return {
            ...component,
            dispose() {
              callbacks.invoke("branch-unsubscribe", unsubscribeBranch, undefined);
              slot.fork(
                FooterRegistryService.use((registry) => registry.setRenderRequest(undefined)),
              );
              installedContext = undefined;
              footerComponent = undefined;
            },
          };
        }),
      undefined,
    );
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

  registerSettingsCommand(pi, { config, updateContext, update, run });

  pi.on("session_start", (_event, ctx) => {
    ensureSubscriptions();
    uninstallFooter();
    MutableRef.set(
      projection,
      freezeSnapshot({
        config: undefined,
        totals: totalsFrom(ctx),
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
      .start({ ctx, context, projectTrusted: isProjectTrusted(ctx) }, ctx.signal)
      .then(() => undefined);
  });

  pi.on("turn_end", (event, ctx) => {
    updateContext(ctx);
    const current = MutableRef.get(projection);
    const totals = { ...current.totals };
    if (event.message?.role === "assistant") {
      totals.input += event.message.usage.input;
      totals.output += event.message.usage.output;
      totals.cacheRead += event.message.usage.cacheRead;
      totals.cacheWrite += event.message.usage.cacheWrite;
      totals.cost += event.message.usage.cost.total;
    } else Object.assign(totals, totalsFrom(ctx));
    footerComponent?.invalidateContextUsage();
    requestRender();
    return run(
      CosmicUiService.use((service) =>
        service.setTotals(totals).pipe(Effect.andThen(service.refreshGit())),
      ),
      ctx.signal,
    ).catch(() => undefined);
  });
  const refreshTotals = (ctx: ExtensionContext) => {
    updateContext(ctx);
    footerComponent?.invalidateContextUsage();
    requestRender();
    return run(
      CosmicUiService.use((service) => service.setTotals(totalsFrom(ctx))),
      ctx.signal,
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
    return run(
      CosmicUiService.use((service) => service.refreshGit(true)),
      ctx.signal,
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
