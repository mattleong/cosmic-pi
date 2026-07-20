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
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  nodePlatformLayer,
} from "pi-cosmic-core";
import { CosmicUiConfigRepository } from "./config/repository.ts";
import { DEFAULT_CONFIG, type ResolvedCosmicUiConfig } from "./config/schema.ts";
import { createFooterComponent, type FooterTotals } from "./footer/component.ts";
import { FooterContributionRegistry } from "./footer/registry.ts";
import { CosmicUiService, emptyTotals, makeProjection } from "./host-service.ts";
import { PiExec } from "./probe/pi-exec.ts";
import { RepositoryProbe } from "./probe/repository-probe.ts";
import {
  COSMIC_UI_FOOTER_INVALIDATE,
  COSMIC_UI_FOOTER_REMOVE,
  COSMIC_UI_FOOTER_UPSERT,
  COSMIC_UI_HOST_QUERY,
  isCosmicFooterInvalidateEvent,
  isCosmicFooterRemoveEvent,
  isCosmicFooterUpsertEvent,
  isCosmicUiHostQuery,
} from "./protocol.ts";
import { registerSettingsCommand } from "./settings/controller.ts";

const terminalUi = (ctx: ExtensionContext) => ctx.mode === "tui";

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

export default function cosmicUi(pi: ExtensionAPI): void {
  const registry = new FooterContributionRegistry();
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
  const requestRender = () => registry.requestRenderNow();
  const uninstallFooter = () => {
    const ctx = installedContext;
    installedContext = undefined;
    footerComponent = undefined;
    registry.setRenderRequest(undefined);
    if (!ctx) return;
    try {
      ctx.ui.setFooter(undefined);
    } catch {
      // Host/footer cleanup must not prevent runtime disposal.
    }
  };

  type SessionInput = {
    readonly ctx: ExtensionContext;
    readonly context: MutableRef.MutableRef<ExtensionContext>;
  };
  const slot = makePiSessionRuntimeSlot<SessionInput, CosmicUiService>({
    makeRuntime: ({ ctx, context }) => {
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
        onChange: requestRender,
      }).pipe(Layer.provide(Layer.merge(configRepository, probe)));
      return makePiManagedRuntime(pi, service);
    },
    startup: () => CosmicUiService.use(() => Effect.void),
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
      try {
        ctx.ui.notify("Cosmic UI failed to start.", "warning");
      } catch {
        // Host notification failures do not prevent runtime cleanup.
      }
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
    ctx.ui.setFooter((tui, theme, footerData) => {
      registry.setRenderRequest(() => tui.requestRender());
      const unsubscribeBranch = footerData.onBranchChange(() => {
        tui.requestRender();
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
        registry,
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
          try {
            unsubscribeBranch();
          } catch {
            // Host branch subscriptions cannot block footer/runtime cleanup.
          }
          registry.setRenderRequest(undefined);
          installedContext = undefined;
          footerComponent = undefined;
        },
      };
    });
  }

  const ensureSubscriptions = () => {
    if (subscriptions.length > 0) return;
    subscriptions = [
      pi.events.on(COSMIC_UI_HOST_QUERY, (data) => {
        if (!isCosmicUiHostQuery(data)) return;
        try {
          data.respond();
        } catch {
          // A hostile query responder cannot break the host event bus.
        }
      }),
      pi.events.on(COSMIC_UI_FOOTER_UPSERT, (data) => {
        try {
          if (isCosmicFooterUpsertEvent(data)) registry.upsert(data.owner, data.contribution);
        } catch {
          // Protocol payload accessors are isolated from the host event bus.
        }
      }),
      pi.events.on(COSMIC_UI_FOOTER_REMOVE, (data) => {
        try {
          if (isCosmicFooterRemoveEvent(data)) registry.remove(data.owner, data.id);
        } catch {
          // Protocol payload accessors are isolated from the host event bus.
        }
      }),
      pi.events.on(COSMIC_UI_FOOTER_INVALIDATE, (data) => {
        try {
          if (isCosmicFooterInvalidateEvent(data)) registry.invalidate(data.owner, data.id);
        } catch {
          // Protocol payload accessors are isolated from the host event bus.
        }
      }),
    ];
  };
  const disposeSubscriptions = () => {
    for (const unsubscribe of subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch {
        // One hostile bus subscription cannot block remaining cleanup.
      }
    }
  };
  ensureSubscriptions();

  registerSettingsCommand(pi, { config, updateContext, update, run });

  pi.on("session_start", (_event, ctx) => {
    ensureSubscriptions();
    uninstallFooter();
    MutableRef.set(projection, {
      config: undefined,
      totals: totalsFrom(ctx),
      gitStatus: undefined,
      pullRequestNumber: undefined,
      pullRequestCheckedAt: 0,
      probeRevision: 0,
      homeDirectory: undefined,
    });
    const context = MutableRef.make(ctx);
    currentContext = context;
    return slot.start({ ctx, context }, ctx.signal).then(() => undefined);
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
    registry.clear();
    return slot.shutdown().then(() => {
      currentContext = undefined;
      MutableRef.set(projection, {
        config: undefined,
        totals: emptyTotals(),
        gitStatus: undefined,
        pullRequestNumber: undefined,
        pullRequestCheckedAt: 0,
        probeRevision: 0,
        homeDirectory: undefined,
      });
    });
  });
}
